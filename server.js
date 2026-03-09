import express from "express";
import cors from "cors";

const app = express();
const PORT = 8787;

app.use(express.json());
app.use(cors());

// =============================
// Gumroad 設定
// =============================

const GUMROAD_ACCESS_TOKEN = "lHg0c4oH4CelxASHoEXqa6zYOWa6CedGbj92UFzigZo";
const PRODUCT_PERMALINK = "rswvg";

// =============================
// サーバー確認
// =============================

app.get("/", (req, res) => {
  res.send("Furima License Server Running");
});

// =============================
// ライセンス認証API
// =============================

app.post("/verify", async (req, res) => {

  try {

    const { license } = req.body;

    if (!license) {
      return res.json({
        valid:false,
        message:"license が必要です"
      });
    }

    const params = new URLSearchParams();

    params.append("access_token", GUMROAD_ACCESS_TOKEN);
    params.append("product_permalink", PRODUCT_PERMALINK);
    params.append("license_key", license);

    const response = await fetch(
      "https://api.gumroad.com/v2/licenses/verify",
      {
        method:"POST",
        headers:{
          "Content-Type":"application/x-www-form-urlencoded"
        },
        body:params.toString()
      }
    );

    const data = await response.json();

    if(data.success){

      console.log("License OK:", license);

      return res.json({
        valid:true,
        purchase:data.purchase
      });

    } else {

      console.log("License NG:", license);

      return res.json({
        valid:false
      });

    }

  } catch(e){

    console.log("Server error:", e);

    return res.json({
      valid:false
    });

  }

});

// =============================
// サーバー起動
// =============================

app.listen(PORT, () => {
  console.log("License server running on port " + PORT);
});