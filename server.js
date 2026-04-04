import fs from "fs";
import path from "path";
import express from "express";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

const PORT = Number(process.env.PORT || 3000);
const TRIAL_DAYS = Number(process.env.TRIAL_DAYS || 7);

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const LICENSES_FILE = path.join(__dirname, "licenses.json");

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing Supabase environment variables");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

app.use(cors());
app.use(express.json());

function nowMs() {
  return Date.now();
}

function readLicensesFile() {
  try {
    if (!fs.existsSync(LICENSES_FILE)) {
      return { licenses: [] };
    }

    const raw = fs.readFileSync(LICENSES_FILE, "utf8");
    const parsed = JSON.parse(raw);

    if (!parsed || !Array.isArray(parsed.licenses)) {
      return { licenses: [] };
    }

    return parsed;
  } catch (e) {
    console.error("readLicensesFile error:", e);
    return { licenses: [] };
  }
}

function findLicenseIndex(licensesData, licenseKey) {
  return licensesData.licenses.findIndex(
    (item) =>
      String(item.licenseKey || "").trim() === String(licenseKey || "").trim()
  );
}

function normalizeLicenseItem(item) {
  return {
    licenseKey: String(item.licenseKey || "").trim(),
    status: String(item.status || "").trim().toLowerCase(),
    plan: String(item.plan || "").trim().toLowerCase(),
    boundDeviceId: String(item.boundDeviceId || "").trim()
  };
}

function buildTrialResponse(record) {
  const now = nowMs();
  const diff = Number(record.end_at) - now;
  const valid = diff > 0;

  const totalMinutes = Math.max(0, Math.floor(diff / (1000 * 60)));
  const remainingDays = Math.floor(totalMinutes / (24 * 60));
  const remainingHours = Math.floor(
    (totalMinutes % (24 * 60)) / 60
  );
  const remainingMinutes = totalMinutes % 60;

  return {
    ok: true,
    valid,
    startAt: Number(record.start_at),
    endAt: Number(record.end_at),
    remainingDays,
    remainingHours,
    remainingMinutes,
    remainingText: valid
      ? `残り ${remainingDays}日 ${remainingHours}時間 ${remainingMinutes}分`
      : null
  };
}

async function getTrialByFingerprint(fingerprint) {
  if (!fingerprint) return null;

  const { data, error } = await supabase
    .from("trials")
    .select("*")
    .eq("fingerprint", fingerprint)
    .order("id", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data;
}

async function getTrialByDeviceId(deviceId) {
  if (!deviceId) return null;

  const { data, error } = await supabase
    .from("trials")
    .select("*")
    .eq("first_device_id", deviceId)
    .order("id", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data;
}

async function updateTrialIdentity(id, fingerprint, deviceId) {
  const payload = {};

  if (fingerprint) {
    payload.fingerprint = fingerprint;
  }

  if (deviceId) {
    payload.first_device_id = deviceId;
  }

  const { data, error } = await supabase
    .from("trials")
    .update(payload)
    .eq("id", id)
    .select("*")
    .single();

  if (error) {
    throw error;
  }

  return data;
}

async function createTrial(fingerprint, deviceId) {
  const startAt = nowMs();
  const endAt = startAt + TRIAL_DAYS * 24 * 60 * 60 * 1000;

  const payload = {
    fingerprint,
    first_device_id: deviceId || null,
    start_at: startAt,
    end_at: endAt
  };

  const { data, error } = await supabase
    .from("trials")
    .insert(payload)
    .select("*")
    .single();

  if (error) {
    throw error;
  }

  return data;
}

async function getExistingTrial(fingerprint, deviceId) {
  const byFingerprint = await getTrialByFingerprint(fingerprint);
  if (byFingerprint) {
    if (
      deviceId &&
      String(byFingerprint.first_device_id || "").trim() !== deviceId
    ) {
      try {
        return await updateTrialIdentity(byFingerprint.id, fingerprint, deviceId);
      } catch (e) {
        console.error("updateTrialIdentity(byFingerprint) error:", e);
        return byFingerprint;
      }
    }

    return byFingerprint;
  }

  const byDeviceId = await getTrialByDeviceId(deviceId);
  if (byDeviceId) {
    if (
      fingerprint &&
      String(byDeviceId.fingerprint || "").trim() !== fingerprint
    ) {
      try {
        return await updateTrialIdentity(byDeviceId.id, fingerprint, deviceId);
      } catch (e) {
        console.error("updateTrialIdentity(byDeviceId) error:", e);
        return byDeviceId;
      }
    }

    return byDeviceId;
  }

  return null;
}

async function getOrCreateTrial(fingerprint, deviceId) {
  let record = await getExistingTrial(fingerprint, deviceId);

  if (record) {
    return record;
  }

  try {
    record = await createTrial(fingerprint, deviceId);
    return record;
  } catch (e) {
    const retry = await getExistingTrial(fingerprint, deviceId);
    if (retry) {
      return retry;
    }
    throw e;
  }
}

async function getBindingByLicenseKey(licenseKey) {
  const { data, error } = await supabase
    .from("license_bindings")
    .select("*")
    .eq("license_key", licenseKey)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data;
}

async function createBinding({ licenseKey, deviceId, plan, status }) {
  const now = nowMs();

  const payload = {
    license_key: licenseKey,
    device_id: deviceId,
    plan: plan || "unknown",
    status: status || "active",
    first_verified_at: now,
    last_verified_at: now
  };

  const { data, error } = await supabase
    .from("license_bindings")
    .insert(payload)
    .select("*")
    .single();

  if (error) {
    throw error;
  }

  return data;
}

async function touchBinding(id) {
  const now = nowMs();

  const { data, error } = await supabase
    .from("license_bindings")
    .update({ last_verified_at: now })
    .eq("id", id)
    .select("*")
    .single();

  if (error) {
    throw error;
  }

  return data;
}

async function verifyLicenseFromStorage(licenseKey, deviceId) {
  const licensesData = readLicensesFile();
  const index = findLicenseIndex(licensesData, licenseKey);

  if (index === -1) {
    return {
      valid: false,
      message: "ライセンスキーが見つかりません"
    };
  }

  const current = normalizeLicenseItem(licensesData.licenses[index]);

  if (!current.licenseKey) {
    return {
      valid: false,
      message: "ライセンスキーが不正です"
    };
  }

  if (current.status !== "active") {
    return {
      valid: false,
      message: "このライセンスキーは無効です"
    };
  }

  if (!deviceId) {
    return {
      valid: false,
      message: "deviceId is required"
    };
  }

  let binding = await getBindingByLicenseKey(current.licenseKey);

  if (binding) {
    if (String(binding.device_id || "").trim() !== deviceId) {
      return {
        valid: false,
        message: "このライセンスキーは別の端末で使用中です"
      };
    }

    const touched = await touchBinding(binding.id);

    return {
      valid: true,
      message: "ライセンス認証が完了しました",
      plan: current.plan || "unknown",
      boundDeviceId: String(touched.device_id || "").trim(),
      newlyBound: false
    };
  }

  if (current.boundDeviceId) {
    if (current.boundDeviceId !== deviceId) {
      return {
        valid: false,
        message: "このライセンスキーは別の端末で使用中です"
      };
    }

    binding = await createBinding({
      licenseKey: current.licenseKey,
      deviceId: current.boundDeviceId,
      plan: current.plan || "unknown",
      status: current.status || "active"
    });

    return {
      valid: true,
      message: "ライセンス認証が完了しました",
      plan: current.plan || "unknown",
      boundDeviceId: String(binding.device_id || "").trim(),
      newlyBound: false,
      migratedFromJson: true
    };
  }

  binding = await createBinding({
    licenseKey: current.licenseKey,
    deviceId,
    plan: current.plan || "unknown",
    status: current.status || "active"
  });

  return {
    valid: true,
    message: "ライセンス認証が完了しました",
    plan: current.plan || "unknown",
    boundDeviceId: String(binding.device_id || "").trim(),
    newlyBound: true
  };
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "furima-license-server",
    storage: "supabase(trials + license_bindings) + licenses.json(master)",
    trialDays: TRIAL_DAYS,
    hasSupabase: Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY)
  });
});

app.post("/verify", async (req, res) => {
  try {
    const { licenseKey, deviceId } = req.body || {};

    if (!licenseKey) {
      return res.status(400).json({
        valid: false,
        message: "licenseKey is required"
      });
    }

    if (!deviceId) {
      return res.status(400).json({
        valid: false,
        message: "deviceId is required"
      });
    }

    const result = await verifyLicenseFromStorage(licenseKey, deviceId);
    return res.json(result);
  } catch (e) {
    console.error("/verify error:", e);

    return res.status(500).json({
      valid: false,
      message: e.message || "server error"
    });
  }
});

app.post("/trial/start", async (req, res) => {
  try {
    const { fingerprint, deviceId } = req.body || {};

    if (!fingerprint && !deviceId) {
      return res.status(400).json({
        ok: false,
        valid: false,
        message: "fingerprint or deviceId is required"
      });
    }

    const record = await getOrCreateTrial(fingerprint, deviceId);

    console.log("trial/start", {
      fingerprint: fingerprint || null,
      deviceId: deviceId || null,
      startAt: record.start_at,
      endAt: record.end_at
    });

    return res.json(buildTrialResponse(record));
  } catch (e) {
    console.error("/trial/start error:", e);

    return res.status(500).json({
      ok: false,
      valid: false,
      message: e.message || "server error"
    });
  }
});

app.post("/trial/status", async (req, res) => {
  try {
    const { fingerprint, deviceId } = req.body || {};

    if (!fingerprint && !deviceId) {
      return res.status(400).json({
        ok: false,
        valid: false,
        message: "fingerprint or deviceId is required"
      });
    }

    const record = await getExistingTrial(fingerprint, deviceId);

    if (!record) {
      return res.json({
        ok: true,
        valid: false,
        notFound: true,
        remainingDays: 0,
        remainingHours: 0,
        remainingMinutes: 0,
        remainingText: null
      });
    }

    return res.json(buildTrialResponse(record));
  } catch (e) {
    console.error("/trial/status error:", e);

    return res.status(500).json({
      ok: false,
      valid: false,
      message: e.message || "server error"
    });
  }
});

// ── フリマ管理アシスト用ライセンス認証 ──────────────────────
app.post("/verify-kanri", async (req, res) => {
  try {
    const { licenseKey, deviceId } = req.body || {};

    if (!licenseKey) {
      return res.status(400).json({
        valid: false,
        message: "licenseKey is required"
      });
    }

    if (!deviceId) {
      return res.status(400).json({
        valid: false,
        message: "deviceId is required"
      });
    }

    // FKA- プレフィックスチェック
    if (!String(licenseKey).startsWith("FKA-")) {
      return res.status(400).json({
        valid: false,
        message: "無効なライセンスキーです（FKA-で始まるキーを入力してください）"
      });
    }

    const result = await verifyLicenseFromStorage(licenseKey, deviceId);
    return res.json(result);
  } catch (e) {
    console.error("/verify-kanri error:", e);
    return res.status(500).json({
      valid: false,
      message: e.message || "server error"
    });
  }
});

// ═══════════════════════════════════════════════════════════════
//  Gumroad Webhook
//  購入 → キー自動発行
//  キャンセル・返金 → キー即無効化
// ═══════════════════════════════════════════════════════════════

const GUMROAD_SECRET = process.env.GUMROAD_WEBHOOK_SECRET || "";

// ランダムなライセンスキー生成
function generateLicenseKey(prefix) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const seg = () => Array.from({ length: 4 }, () =>
    chars[Math.floor(Math.random() * chars.length)]
  ).join("");
  return `${prefix}-${seg()}-${seg()}-${seg()}`;
}

// licenses.jsonに書き込む
function writeLicensesFile(data) {
  fs.writeFileSync(LICENSES_FILE, JSON.stringify(data, null, 2), "utf8");
}

// プロダクトIDからプレフィックスを判定
function getPrefixFromProductId(productId) {
  const PRODUCT_MAP = {
    // Gumroadの商品IDを設定（後で変更可能）
    "furima_kanri_month": "FKA",
    "furima_kanri_year":  "FKA",
    "furima_pro_month":   "FRP",
    "furima_pro_year":    "FRP",
  };
  return PRODUCT_MAP[productId] || "FKA";
}

// プランを判定
function getPlanFromProductId(productId) {
  if (String(productId).includes("year")) return "year";
  return "month";
}

app.post("/webhook/gumroad", async (req, res) => {
  try {
    const body = req.body || {};

    // Gumroadのwebhookデータ
    const resourceName   = body.resource_name   || ""; // "sale" or "cancellation" or "refund"
    const productId      = body.product_id       || body.short_product_id || "";
    const buyerEmail     = body.email            || "";
    const saleId         = body.sale_id          || body.id || "";
    const refunded       = body.refunded         === true || body.refunded === "true";
    const chargebacked   = body.chargebacked      === true || body.chargebacked === "true";

    console.log("Gumroad webhook:", { resourceName, productId, buyerEmail, saleId, refunded });

    // ── 購入時: キーを自動発行 ──
    if (resourceName === "sale" && !refunded && !chargebacked) {
      const prefix     = getPrefixFromProductId(productId);
      const plan       = getPlanFromProductId(productId);
      const licenseKey = generateLicenseKey(prefix);

      const licensesData = readLicensesFile();
      licensesData.licenses.push({
        licenseKey,
        status:        "active",
        plan,
        boundDeviceId: "",
        buyerEmail,
        saleId,
        createdAt:     new Date().toISOString()
      });
      writeLicensesFile(licensesData);

      console.log("✅ キー発行:", licenseKey, buyerEmail);

      // Supabaseにも記録
      try {
        await supabase.from("license_issues").insert({
          license_key:  licenseKey,
          buyer_email:  buyerEmail,
          sale_id:      saleId,
          plan,
          status:       "active",
          created_at:   Date.now()
        });
      } catch(e) {
        console.warn("Supabase記録失敗（無視）:", e.message);
      }

      return res.json({ ok: true, action: "issued", licenseKey });
    }

    // ── キャンセル・返金時: キーを即無効化 ──
    if (
      resourceName === "cancellation" ||
      resourceName === "refund" ||
      refunded ||
      chargebacked
    ) {
      const licensesData = readLicensesFile();
      let cancelled = 0;

      licensesData.licenses = licensesData.licenses.map(item => {
        if (String(item.saleId || "") === String(saleId) ||
            String(item.buyerEmail || "").toLowerCase() === buyerEmail.toLowerCase()) {
          cancelled++;
          console.log("🚫 キー無効化:", item.licenseKey, buyerEmail);
          return { ...item, status: "cancelled", cancelledAt: new Date().toISOString() };
        }
        return item;
      });

      writeLicensesFile(licensesData);

      // Supabaseのbindingも無効化
      if (saleId) {
        try {
          await supabase
            .from("license_bindings")
            .update({ status: "cancelled" })
            .eq("sale_id", saleId);
        } catch(e) {
          console.warn("Supabase無効化失敗（無視）:", e.message);
        }
      }

      return res.json({ ok: true, action: "cancelled", count: cancelled });
    }

    // その他のイベントは無視
    return res.json({ ok: true, action: "ignored", resourceName });

  } catch (e) {
    console.error("/webhook/gumroad error:", e);
    return res.status(500).json({ ok: false, message: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`License server running on port ${PORT}`);
});