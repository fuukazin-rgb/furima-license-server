import express from "express";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";
import dns from "node:dns";

// Render無料プランはIPv6の外向き通信ができないため、IPv4を優先させる
dns.setDefaultResultOrder("ipv4first");

// ★メール送信について★
// Renderの無料プランは SMTPポート（25/465/587）を全てブロックしている。
// そのため nodemailer（SMTP）は使えない。
// 代わりに Brevo の HTTP API（https / 443番ポート）でメールを送る。
// 443番はブロックされないため、無料プランでも確実に送信できる。

const app = express();

const PORT = Number(process.env.PORT || 3000);
const TRIAL_DAYS = Number(process.env.TRIAL_DAYS || 7);

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const BREVO_API_KEY = process.env.BREVO_API_KEY || "";
// Brevoに登録・認証済みの送信元アドレス
const SENDER_EMAIL  = process.env.SENDER_EMAIL || "niche.frima@gmail.com";
const SENDER_NAME   = "niche-hobby";
// 送信失敗の通知先（未設定なら SENDER_EMAIL 宛）
const ADMIN_EMAIL   = process.env.ADMIN_EMAIL || SENDER_EMAIL;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing Supabase environment variables");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const mailerReady = Boolean(BREVO_API_KEY);

if (!mailerReady) {
  console.error("⚠️ BREVO_API_KEY が未設定です。メールは送信されません。");
}

// 起動時に Brevo API キーが有効か確認する（失敗してもサーバーは止めない）
if (mailerReady) {
  fetch("https://api.brevo.com/v3/account", {
    method: "GET",
    headers: { "api-key": BREVO_API_KEY, "accept": "application/json" }
  })
    .then(async res => {
      if (res.ok) {
        console.log("✅ Brevo API 接続OK / 送信元:", SENDER_EMAIL);
      } else {
        const body = await res.text();
        console.error("❌ Brevo API 接続NG:", res.status, body.slice(0, 200));
      }
    })
    .catch(e => console.error("❌ Brevo API 接続NG:", e.message));
}

app.use(cors());
app.use(express.json());
// ★Gumroadのwebhook(Ping)は application/x-www-form-urlencoded で届くため必須
app.use(express.urlencoded({ extended: true }));

function nowMs() {
  return Date.now();
}

function buildTrialResponse(record) {
  const now = nowMs();
  const diff = Number(record.end_at) - now;
  const valid = diff > 0;
  const totalMinutes = Math.max(0, Math.floor(diff / (1000 * 60)));
  const remainingDays = Math.floor(totalMinutes / (24 * 60));
  const remainingHours = Math.floor((totalMinutes % (24 * 60)) / 60);
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

// ── メール送信（Brevo HTTP API） ───────────────────────────────
// SMTPではなく https://api.brevo.com へのPOSTで送る（443番ポートなのでRenderでも通る）
// 成功なら true / 失敗なら false を返す（呼び出し側で必ず確認すること）
async function sendMail({ to, subject, html, fromName }) {
  if (!mailerReady) {
    console.error("❌ メール送信不可（BREVO_API_KEY未設定）:", to, subject);
    return false;
  }
  try {
    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "api-key": BREVO_API_KEY,
        "content-type": "application/json",
        "accept": "application/json"
      },
      body: JSON.stringify({
        sender: { name: fromName || SENDER_NAME, email: SENDER_EMAIL },
        to: [{ email: to }],
        subject,
        htmlContent: html
      })
    });

    if (!res.ok) {
      const body = await res.text();
      console.error("❌ メール送信失敗:", to, "| HTTP", res.status, "|", body.slice(0, 300));
      return false;
    }

    const data = await res.json().catch(() => ({}));
    console.log("✉️ メール送信完了:", to, "|", subject, "| messageId:", data.messageId || "(不明)");
    return true;
  } catch (e) {
    console.error("❌ メール送信失敗:", to, "|", e.message);
    return false;
  }
}

// 送信に失敗したとき、自分自身に警告メールを送る
async function notifyAdminOfFailure({ buyerEmail, licenseKey, productName, reason }) {
  if (!mailerReady || !ADMIN_EMAIL) return;
  const html = `
<!DOCTYPE html>
<html lang="ja">
<head><meta charset="UTF-8"></head>
<body style="font-family:sans-serif;padding:20px;color:#333;">
  <h2 style="color:#e74c3c;">⚠️ ライセンスキーのメール送信に失敗しました</h2>
  <p><strong>至急、手動でキーをお客様に送ってください。</strong></p>
  <table border="1" cellpadding="8" style="border-collapse:collapse;">
    <tr><td>購入者メール</td><td><strong>${buyerEmail || "(不明)"}</strong></td></tr>
    <tr><td>ライセンスキー</td><td><strong>${licenseKey || "(不明)"}</strong></td></tr>
    <tr><td>商品</td><td>${productName || "(不明)"}</td></tr>
    <tr><td>理由</td><td>${reason || "(不明)"}</td></tr>
    <tr><td>発生時刻</td><td>${new Date().toISOString()}</td></tr>
  </table>
</body>
</html>
  `;
  const ok = await sendMail({
    to: ADMIN_EMAIL,
    subject: `🚨【要対応】ライセンスキー送信失敗（${buyerEmail || "不明"}）`,
    html,
    fromName: "niche-hobby system"
  });
  if (ok) {
    console.log("🚨 管理者へ失敗通知を送信しました:", ADMIN_EMAIL);
  } else {
    console.error("管理者通知すら失敗しました");
  }
}

async function sendLicenseEmail(buyerEmail, licenseKey, plan, productName) {
  const planLabel = plan === "year" ? "年額プラン" : "月額プラン";

  const html = `
<!DOCTYPE html>
<html lang="ja">
<head><meta charset="UTF-8"></head>
<body style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#333;">
  <h2 style="color:#4a90e2;">【niche-hobby】ライセンスキーのご案内</h2>
  <p>この度は <strong>${productName}（${planLabel}）</strong> をご購入いただき、誠にありがとうございます。</p>
  <p>以下のライセンスキーを拡張機能の認証画面に入力してください。</p>
  <div style="background:#f5f5f5;border:2px solid #4a90e2;border-radius:8px;padding:20px;text-align:center;margin:20px 0;">
    <p style="font-size:13px;color:#666;margin:0 0 8px;">ライセンスキー</p>
    <p style="font-size:22px;font-weight:bold;letter-spacing:2px;color:#222;margin:0;">${licenseKey}</p>
  </div>
  <h3>ご利用方法</h3>
  <ol>
    <li>Chrome拡張機能のアイコンをクリック</li>
    <li>「ライセンスキーを入力」欄に上記キーを貼り付け</li>
    <li>「認証」ボタンを押して完了</li>
  </ol>
  <p style="color:#e74c3c;font-size:13px;">※ このキーは1台の端末専用です。端末を変更する場合はサポートまでご連絡ください。</p>
  <hr style="border:none;border-top:1px solid #eee;margin:20px 0;">
  <p style="font-size:13px;">
    ご不明な点はお気軽にご連絡ください。<br>
    ● メール：${SENDER_EMAIL}<br>
    ● LINE公式アカウント （@978rgtyk）　→ https://lin.ee/u6rgCbP
  </p>
</body>
</html>
  `;

  return await sendMail({
    to: buyerEmail,
    subject: `【niche-hobby】ライセンスキーをお届けします（${productName}）`,
    html
  });
}

async function sendCancelEmail(buyerEmail, licenseKey, productName) {
  const html = `
<!DOCTYPE html>
<html lang="ja">
<head><meta charset="UTF-8"></head>
<body style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#333;">
  <h2 style="color:#e74c3c;">【niche-hobby】ご解約のご連絡</h2>
  <p><strong>${productName}</strong> のご解約を承りました。</p>
  <p>ライセンスキー <strong>${licenseKey}</strong> は無効化されました。</p>
  <p>またのご利用をお待ちしております。</p>
  <hr style="border:none;border-top:1px solid #eee;margin:20px 0;">
  <p style="font-size:13px;">
    ● メール：${SENDER_EMAIL}<br>
    ● LINE公式アカウント （@978rgtyk）　→ https://lin.ee/u6rgCbP
  </p>
</body>
</html>
  `;

  return await sendMail({
    to: buyerEmail,
    subject: `【niche-hobby】ご解約を承りました（${productName}）`,
    html
  });
}

// licenses テーブルにメール送信結果を記録する（email_sent カラム）
async function markEmailSent(licenseKey, sent) {
  try {
    await supabase
      .from("licenses")
      .update({ email_sent: sent })
      .eq("license_key", licenseKey);
  } catch (e) {
    console.warn("email_sent の記録に失敗（無視）:", e.message);
  }
}

// ── licenses テーブル操作（旧 licenses.json の置き換え） ──────────
async function getLicenseByKey(licenseKey) {
  const key = String(licenseKey || "").trim();
  if (!key) return null;
  const { data, error } = await supabase
    .from("licenses")
    .select("*")
    .eq("license_key", key)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function insertLicense({ licenseKey, status, plan, buyerEmail, saleId, productId }) {
  const payload = {
    license_key:     licenseKey,
    status:          status || "active",
    plan:            plan || "unknown",
    bound_device_id: "",
    buyer_email:     buyerEmail || null,
    sale_id:         saleId || null,
    product_id:      productId || null
  };
  const { data, error } = await supabase
    .from("licenses")
    .insert(payload)
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

async function cancelLicensesBySaleOrEmail(saleId, buyerEmail) {
  const conditions = [];
  if (saleId) conditions.push(`sale_id.eq.${saleId}`);
  if (buyerEmail) conditions.push(`buyer_email.ilike.${buyerEmail}`);
  if (conditions.length === 0) return [];

  // active なものだけ対象に検索
  const { data: matches, error: findError } = await supabase
    .from("licenses")
    .select("*")
    .eq("status", "active")
    .or(conditions.join(","));
  if (findError) throw findError;
  if (!matches || matches.length === 0) return [];

  const keys = matches.map(m => m.license_key);
  const { data: updated, error: updateError } = await supabase
    .from("licenses")
    .update({ status: "cancelled", cancelled_at: new Date().toISOString() })
    .in("license_key", keys)
    .select("*");
  if (updateError) throw updateError;
  return updated || [];
}

// ── trials テーブル ─────────────────────────────────────────────
async function getTrialByFingerprint(fingerprint) {
  if (!fingerprint) return null;
  const { data, error } = await supabase
    .from("trials")
    .select("*")
    .eq("fingerprint", fingerprint)
    .order("id", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
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
  if (error) throw error;
  return data;
}

async function updateTrialIdentity(id, fingerprint, deviceId) {
  const payload = {};
  if (fingerprint) payload.fingerprint = fingerprint;
  if (deviceId) payload.first_device_id = deviceId;
  const { data, error } = await supabase
    .from("trials")
    .update(payload)
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw error;
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
  if (error) throw error;
  return data;
}

async function getExistingTrial(fingerprint, deviceId) {
  const byFingerprint = await getTrialByFingerprint(fingerprint);
  if (byFingerprint) {
    if (deviceId && String(byFingerprint.first_device_id || "").trim() !== deviceId) {
      try {
        return await updateTrialIdentity(byFingerprint.id, fingerprint, deviceId);
      } catch (e) {
        return byFingerprint;
      }
    }
    return byFingerprint;
  }
  const byDeviceId = await getTrialByDeviceId(deviceId);
  if (byDeviceId) {
    if (fingerprint && String(byDeviceId.fingerprint || "").trim() !== fingerprint) {
      try {
        return await updateTrialIdentity(byDeviceId.id, fingerprint, deviceId);
      } catch (e) {
        return byDeviceId;
      }
    }
    return byDeviceId;
  }
  return null;
}

async function getOrCreateTrial(fingerprint, deviceId) {
  let record = await getExistingTrial(fingerprint, deviceId);
  if (record) return record;
  try {
    record = await createTrial(fingerprint, deviceId);
    return record;
  } catch (e) {
    const retry = await getExistingTrial(fingerprint, deviceId);
    if (retry) return retry;
    throw e;
  }
}

// ── license_bindings テーブル ───────────────────────────────────
async function getBindingByLicenseKey(licenseKey) {
  const { data, error } = await supabase
    .from("license_bindings")
    .select("*")
    .eq("license_key", licenseKey)
    .maybeSingle();
  if (error) throw error;
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
  if (error) throw error;
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
  if (error) throw error;
  return data;
}

// ── ライセンス認証ロジック ──────────────────────────────────────
async function verifyLicenseFromStorage(licenseKey, deviceId) {
  const license = await getLicenseByKey(licenseKey);
  if (!license) return { valid: false, message: "ライセンスキーが見つかりません" };

  const status       = String(license.status || "").toLowerCase();
  const planVal      = String(license.plan || "").toLowerCase() || "unknown";
  const masterDevice = String(license.bound_device_id || "").trim();

  if (status !== "active") return { valid: false, message: "このライセンスキーは無効です" };
  if (!deviceId) return { valid: false, message: "deviceId is required" };

  let binding = await getBindingByLicenseKey(license.license_key);
  if (binding) {
    if (String(binding.device_id || "").trim() !== deviceId) {
      return { valid: false, message: "このライセンスキーは別の端末で使用中です" };
    }
    const touched = await touchBinding(binding.id);
    return {
      valid: true,
      message: "ライセンス認証が完了しました",
      plan: planVal,
      boundDeviceId: String(touched.device_id || "").trim(),
      newlyBound: false
    };
  }

  if (masterDevice) {
    if (masterDevice !== deviceId) {
      return { valid: false, message: "このライセンスキーは別の端末で使用中です" };
    }
    binding = await createBinding({
      licenseKey: license.license_key,
      deviceId: masterDevice,
      plan: planVal,
      status
    });
    return {
      valid: true,
      message: "ライセンス認証が完了しました",
      plan: planVal,
      boundDeviceId: String(binding.device_id || "").trim(),
      newlyBound: false,
      migratedFromJson: true
    };
  }

  binding = await createBinding({
    licenseKey: license.license_key,
    deviceId,
    plan: planVal,
    status
  });
  return {
    valid: true,
    message: "ライセンス認証が完了しました",
    plan: planVal,
    boundDeviceId: String(binding.device_id || "").trim(),
    newlyBound: true
  };
}

// ── ルート ──────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "furima-license-server",
    storage: "supabase(licenses + trials + license_bindings)",
    trialDays: TRIAL_DAYS,
    hasSupabase: Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY),
    hasMailer: mailerReady
  });
});

// ══════════════════════════════════════════════════════════════
// ★【一時的・検証用】Brevo送信テスト用エンドポイント★
// 使い方：ブラウザで下記URLを開くと、指定アドレスに1通テストメールを送る。
//   https://furima-license-server-1.onrender.com/test-mail?to=niche.frima@gmail.com
// 「to=」を省略すると SENDER_EMAIL（niche.frima@gmail.com）宛に送る。
// ★検証が終わったら、この app.get("/test-mail", ...) のブロックごと削除してOK。★
// ══════════════════════════════════════════════════════════════
app.get("/test-mail", async (req, res) => {
  const to = String(req.query.to || SENDER_EMAIL).trim();
  console.log("🧪 /test-mail 実行 →", to);

  const html = `
<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8"></head>
<body style="font-family:sans-serif;padding:20px;color:#333;">
  <h2 style="color:#4a90e2;">✅ Brevo送信テスト成功</h2>
  <p>このメールが届いていれば、Brevo経由のメール送信は正常に動いています。</p>
  <p>送信時刻: ${new Date().toISOString()}</p>
</body></html>
  `;

  const sent = await sendMail({
    to,
    subject: "【niche-hobby】Brevo送信テスト",
    html
  });

  if (sent) {
    return res.json({ ok: true, message: `送信しました: ${to}。受信トレイ（と迷惑メール）を確認してください。` });
  } else {
    return res.status(500).json({ ok: false, message: "送信に失敗しました。Renderのログを確認してください。" });
  }
});

app.post("/verify", async (req, res) => {
  try {
    const { licenseKey, deviceId } = req.body || {};
    if (!licenseKey) return res.status(400).json({ valid: false, message: "licenseKey is required" });
    if (!deviceId) return res.status(400).json({ valid: false, message: "deviceId is required" });
    const result = await verifyLicenseFromStorage(licenseKey, deviceId);
    return res.json(result);
  } catch (e) {
    console.error("/verify error:", e);
    return res.status(500).json({ valid: false, message: e.message || "server error" });
  }
});

app.post("/verify-kanri", async (req, res) => {
  try {
    const { licenseKey, deviceId } = req.body || {};
    if (!licenseKey) return res.status(400).json({ valid: false, message: "licenseKey is required" });
    if (!deviceId) return res.status(400).json({ valid: false, message: "deviceId is required" });
    if (!String(licenseKey).startsWith("FKA-")) {
      return res.status(400).json({ valid: false, message: "無効なライセンスキーです（FKA-で始まるキーを入力してください）" });
    }
    const result = await verifyLicenseFromStorage(licenseKey, deviceId);
    return res.json(result);
  } catch (e) {
    console.error("/verify-kanri error:", e);
    return res.status(500).json({ valid: false, message: e.message || "server error" });
  }
});

app.post("/trial/start", async (req, res) => {
  try {
    const { fingerprint, deviceId } = req.body || {};
    if (!fingerprint && !deviceId) {
      return res.status(400).json({ ok: false, valid: false, message: "fingerprint or deviceId is required" });
    }
    const record = await getOrCreateTrial(fingerprint, deviceId);
    return res.json(buildTrialResponse(record));
  } catch (e) {
    console.error("/trial/start error:", e);
    return res.status(500).json({ ok: false, valid: false, message: e.message || "server error" });
  }
});

app.post("/trial/status", async (req, res) => {
  try {
    const { fingerprint, deviceId } = req.body || {};
    if (!fingerprint && !deviceId) {
      return res.status(400).json({ ok: false, valid: false, message: "fingerprint or deviceId is required" });
    }
    const record = await getExistingTrial(fingerprint, deviceId);
    if (!record) {
      return res.json({ ok: true, valid: false, notFound: true, remainingDays: 0, remainingHours: 0, remainingMinutes: 0, remainingText: null });
    }
    return res.json(buildTrialResponse(record));
  } catch (e) {
    console.error("/trial/status error:", e);
    return res.status(500).json({ ok: false, valid: false, message: e.message || "server error" });
  }
});

// ── 開発・サポート用: トライアルのリセット ──
app.post("/trial/reset", async (req, res) => {
  try {
    const { deviceId, fingerprint } = req.body || {};
    if (!deviceId && !fingerprint) {
      return res.status(400).json({ ok: false, message: "deviceId or fingerprint is required" });
    }
    let deletedCount = 0;
    if (deviceId) {
      const { error, count } = await supabase.from("trials").delete().eq("first_device_id", deviceId);
      if (error) throw error;
      deletedCount += (count || 0);
    }
    if (fingerprint) {
      const { error, count } = await supabase.from("trials").delete().eq("fingerprint", fingerprint);
      if (error) throw error;
      deletedCount += (count || 0);
    }
    return res.json({ ok: true, message: "トライアルをリセットしました。再度 /trial/start を呼んでください。", deletedCount });
  } catch (e) {
    console.error("/trial/reset error:", e);
    return res.status(500).json({ ok: false, message: e.message || "server error" });
  }
});

// ── Gumroad Webhook（購入→キー発行→メール自動送信、キャンセル→即無効化） ──
function generateLicenseKey(prefix) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const seg = () => Array.from({ length: 4 }, () =>
    chars[Math.floor(Math.random() * chars.length)]
  ).join("");
  return `${prefix}-${seg()}-${seg()}-${seg()}`;
}

function getPrefixFromProductId(productId) {
  const id = String(productId).toLowerCase();
  if (id.includes("kanri") || id.includes("fka")) return "FKA";
  return "FRP";
}

function getPlanFromProductId(productId) {
  if (String(productId).toLowerCase().includes("year")) return "year";
  return "month";
}

// Gumroadの recurrence（"monthly" / "yearly"）からプランを判定（最優先）
function getPlanFromBody(body) {
  const rec = String(body.recurrence || "").toLowerCase();
  if (rec === "yearly" || rec === "annually" || rec === "year") return "year";
  if (rec === "monthly" || rec === "month") return "month";
  return getPlanFromProductId(
    body.product_id || body.short_product_id || body.product_permalink || ""
  );
}

function getProductNameFromProductId(productId) {
  const id = String(productId).toLowerCase();
  if (id.includes("kanri") || id.includes("fka")) return "フリマ管理アシスト";
  return "フリマ出品アシスト Pro";
}

app.post("/webhook/gumroad", async (req, res) => {
  try {
    const body = req.body || {};

    console.log("=== Gumroad webhook RAW body ===");
    console.log(JSON.stringify(body, null, 2));
    console.log("=== Content-Type:", req.headers["content-type"], "===");

    const resourceName   = body.resource_name   || body.resourceName   || "";
    const productId      = body.product_id       || body.short_product_id || body.product_permalink || body.permalink || "";
    const buyerEmail     = body.email            || body.purchaser_email || body.buyer_email || "";
    const saleId         = body.sale_id          || body.id || body.order_number || "";
    const refunded       = body.refunded         === true || body.refunded === "true";
    const chargebacked   = body.chargebacked     === true || body.chargebacked === "true";
    const disputed       = body.disputed         === true || body.disputed === "true";
    const cancelled      = body.cancelled        === true || body.cancelled === "true";
    const isCancelEvent  = refunded || chargebacked || disputed || cancelled;
    const isTest         = body.test === true || body.test === "true";

    console.log("Gumroad webhook parsed:", { resourceName, productId, buyerEmail, saleId, refunded, isCancelEvent, isTest });

    // ── 購入時: キー自動発行 → メール自動送信 ──
    const isSaleEvent = Boolean(saleId)
      && !isCancelEvent
      && resourceName !== "cancellation"
      && resourceName !== "refund";

    if (isSaleEvent) {
      const prefix      = getPrefixFromProductId(productId);
      const plan        = getPlanFromBody(body);
      const productName = getProductNameFromProductId(productId);

      if (isTest) {
        console.log("🧪 テストPing検知: 実発行はスキップします。判定結果 →", { prefix, plan, productName, buyerEmail });
        return res.json({ ok: true, action: "test_ok", would_issue: { prefix, plan, productName, buyerEmail } });
      }

      const licenseKey = generateLicenseKey(prefix);

      try {
        await insertLicense({
          licenseKey,
          status:     "active",
          plan,
          buyerEmail,
          saleId,
          productId:  String(productId || "")
        });
        console.log("✅ キー発行:", licenseKey, buyerEmail);
      } catch (e) {
        console.error("キー発行失敗:", e.message);
        return res.status(500).json({ ok: false, message: "キー発行に失敗しました" });
      }

      // ★メール送信の成否を必ず確認する（握りつぶさない）
      const sent = await sendLicenseEmail(buyerEmail, licenseKey, plan, productName);
      await markEmailSent(licenseKey, sent);

      if (!sent) {
        // 送信できなかった → 自分に緊急通知を送り、手動対応できるようにする
        console.error("🚨 キーは発行されたがメールが届いていません:", licenseKey, buyerEmail);
        await notifyAdminOfFailure({
          buyerEmail,
          licenseKey,
          productName,
          reason: "sendLicenseEmail が false を返しました（SMTP設定 or 送信エラー）"
        });
        return res.json({ ok: true, action: "issued_but_email_failed", licenseKey });
      }

      return res.json({ ok: true, action: "issued", licenseKey, emailSent: true });
    }

    // ── キャンセル・返金時: キー即無効化 → メール通知 ──
    if (
      resourceName === "cancellation" ||
      resourceName === "refund" ||
      isCancelEvent
    ) {
      let cancelledRows = [];
      try {
        cancelledRows = await cancelLicensesBySaleOrEmail(saleId, buyerEmail);
      } catch (e) {
        console.error("キー無効化失敗:", e.message);
        return res.status(500).json({ ok: false, message: "キー無効化に失敗しました" });
      }

      // license_bindings側も無効化
      if (saleId) {
        try {
          await supabase.from("license_bindings").update({ status: "cancelled" }).eq("sale_id", saleId);
        } catch (e) {
          console.warn("license_bindings無効化失敗（無視）:", e.message);
        }
      }

      // 解約メール送信（無効化された各キーに対して）
      for (const row of cancelledRows) {
        const email = row.buyer_email || buyerEmail;
        const pid   = row.product_id  || productId;
        if (email && row.license_key) {
          const productName = getProductNameFromProductId(pid);
          await sendCancelEmail(email, row.license_key, productName);
          console.log("🚫 キー無効化:", row.license_key, email);
        }
      }

      return res.json({ ok: true, action: "cancelled", count: cancelledRows.length });
    }

    return res.json({ ok: true, action: "ignored", resourceName });

  } catch (e) {
    console.error("/webhook/gumroad error:", e);
    return res.status(500).json({ ok: false, message: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`License server running on port ${PORT}`);
});
