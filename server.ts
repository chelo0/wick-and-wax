import express from "express";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import cors from "cors";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { v4 as uuidv4 } from "uuid";
import { readFileSync, writeFileSync, existsSync, copyFileSync } from "fs";
import Stripe from "stripe";
import nodemailer from "nodemailer";
import rateLimit from "express-rate-limit";
import helmet from "helmet";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const JWT_SECRET = process.env.JWT_SECRET || "wick-and-wax-secret-key-change-in-production";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "", {
  apiVersion: "2024-12-18.acacia",
});

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp.mailtrap.io",
  port: Number(process.env.SMTP_PORT || 2525),
  auth: {
    user: process.env.SMTP_USER || "",
    pass: process.env.SMTP_PASS || "",
  },
});

const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(",").map((o) => o.trim()).filter(Boolean) || [
  "https://wickandwax.app",
  "http://localhost:5173",
  "http://192.168.100.6:3000",
];

const corsOptions = {
  origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error("Not allowed by CORS"));
  },
  credentials: true,
};

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(helmet());
app.use(cors(corsOptions));
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));
app.use("/api/", apiLimiter);
app.use("/api/auth/login", authLimiter);
app.use("/api/auth/register", authLimiter);

// JSON file-based storage
const DB_FILE = path.join(__dirname, "wickandwax.json");

interface User {
  id: string;
  email: string;
  password: string;
  full_name: string | null;
  plan: string;
  is_active: boolean;
  created_at: string;
}

interface DbRecord {
  id: string;
  user_id: string;
  data: string;
  created_at: string;
}

interface Database {
  users: User[];
  recipes: DbRecord[];
  inventory: DbRecord[];
  orders: DbRecord[];
  stores: DbRecord[];
  purchaseOrders: DbRecord[];
  suppliers: DbRecord[];
  calendarEvents: DbRecord[];
  labels: DbRecord[];
  batches: DbRecord[];
  burnTests: DbRecord[];
  ledger: DbRecord[];
  events: DbRecord[];
  recipeVersions: DbRecord[];
  skuBarcodes: DbRecord[];
}

let db: Database = {
  users: [],
  recipes: [],
  inventory: [],
  orders: [],
  stores: [],
  purchaseOrders: [],
  suppliers: [],
  calendarEvents: [],
  labels: [],
  batches: [],
  burnTests: [],
  ledger: [],
  events: [],
  recipeVersions: [],
  skuBarcodes: [],
};

function loadDb() {
  try {
    if (existsSync(DB_FILE)) {
      const raw = JSON.parse(readFileSync(DB_FILE, "utf-8"));
      db = {
        users: raw.users || [],
        recipes: raw.recipes || [],
        inventory: raw.inventory || [],
        orders: raw.orders || [],
        stores: raw.stores || [],
        purchaseOrders: raw.purchaseOrders || [],
        suppliers: raw.suppliers || [],
        calendarEvents: raw.calendarEvents || [],
        labels: raw.labels || [],
        batches: raw.batches || [],
        burnTests: raw.burnTests || [],
        ledger: raw.ledger || [],
        events: raw.events || [],
        recipeVersions: raw.recipeVersions || [],
        skuBarcodes: raw.skuBarcodes || [],
      };
    }
  } catch (e) {
    console.error("Failed to load database:", e);
    db = { users: [], recipes: [], inventory: [], orders: [], stores: [], purchaseOrders: [], suppliers: [], calendarEvents: [], labels: [], batches: [], burnTests: [], ledger: [], events: [], recipeVersions: [], skuBarcodes: [] };
  }
}

function saveDb() {
  try {
    if (existsSync(DB_FILE)) {
      const backupDir = path.join(__dirname, "backups");
      if (!existsSync(backupDir)) writeFileSync(backupDir + "/.gitkeep", "");
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      copyFileSync(DB_FILE, path.join(backupDir, `wickandwax-${timestamp}.json`));
    }
    writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  } catch (e) {
    console.error("Failed to save database:", e);
  }
}

loadDb();

// Payment Plans
const PLANS = [
  {
    id: "free",
    name: "Free",
    price: 0,
    currency: "EUR",
    features: [
      "10 rețete preinstalate",
      "Inventar basic",
      "Etichete standard",
      "AI Copilot limitat",
      "Export Excel"
    ],
    limits: {
      recipes: 10,
      inventory: 50,
      labels: 10,
      aiRequests: 5
    }
  },
  {
    id: "pro",
    name: "Pro",
    price: 9.99,
    currency: "EUR",
    features: [
      "Rețete illimitate",
      "Inventar avansat",
      "Etichete personalizate",
      "AI Copilot nelimitat",
      "Export Excel + PDF",
      "Prioritate suport"
    ],
    limits: {
      recipes: -1,
      inventory: -1,
      labels: -1,
      aiRequests: -1
    }
  },
  {
    id: "business",
    name: "Business",
    price: 24.99,
    currency: "EUR",
    features: [
      "Tot din Pro",
      "Utilizatori multipli",
      "API access",
      "White-label",
      "Suport dedicat",
      "SLA garantat"
    ],
    limits: {
      recipes: -1,
      inventory: -1,
      labels: -1,
      aiRequests: -1
    }
  }
];

// Auth middleware
const authenticateToken = (req: any, res: any, next: any) => {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) {
    return res.status(401).json({ detail: "Token lipsă" });
  }

  jwt.verify(token, JWT_SECRET, (err: any, user: any) => {
    if (err) return res.status(403).json({ detail: "Token invalid" });
    req.user = user;
    next();
  });
};

const PLAN_RANK: Record<string, number> = { free: 0, pro: 1, business: 2 };

const requirePlan = (required: string) => {
  return (req: any, res: any, next: any) => {
    try {
      const user = db.users.find((u) => u.id === req.user.userId);
      if (!user) return res.status(404).json({ detail: "Utilizator negăsit" });
      const userRank = PLAN_RANK[user.plan] ?? 0;
      const requiredRank = PLAN_RANK[required] ?? 0;
      if (userRank < requiredRank) {
        return res.status(403).json({ detail: `Plan necesar: ${required}` });
      }
      next();
    } catch (err: any) {
      res.status(500).json({ detail: err.message });
    }
  };
};

const aiUsage = new Map<string, { count: number; resetAt: number }>();

const requireAiAccess = (req: any, res: any, next: any) => {
  try {
    const user = db.users.find((u) => u.id === req.user.userId);
    if (!user) return res.status(404).json({ detail: "Utilizator negăsit" });
    if (user.plan === "pro" || user.plan === "business") {
      return next();
    }
    const now = Date.now();
    const record = aiUsage.get(req.user.userId);
    if (!record || now > record.resetAt) {
      aiUsage.set(req.user.userId, { count: 1, resetAt: now + 30 * 24 * 60 * 60 * 1000 });
      return next();
    }
    if (record.count >= 5) {
      return res.status(429).json({ detail: "Limita lunară de cereri AI atinsă (5/lună). Upgradează la Pro pentru AI nelimitat." });
    }
    record.count += 1;
    next();
  } catch (err: any) {
    res.status(500).json({ detail: err.message });
  }
};

// Auth endpoints
app.post("/api/auth/register", (req, res) => {
  try {
    const { email, password, full_name } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ detail: "Email și parolă sunt obligatorii" });
    }

    const existingUser = db.users.find((u) => u.email === email);
    if (existingUser) {
      return res.status(400).json({ detail: "Email deja înregistrat" });
    }

    const userId = uuidv4();
    const hashedPassword = bcrypt.hashSync(password, 10);
    
    const newUser: User = {
      id: userId,
      email,
      password: hashedPassword,
      full_name: full_name || null,
      plan: "free",
      is_active: true,
      created_at: new Date().toISOString(),
    };

    db.users.push(newUser);
    saveDb();

    const token = jwt.sign({ userId, email }, JWT_SECRET, { expiresIn: "7d" });

    sendEmail(
      email,
      "Bine ai venit la Wick & Wax!",
      `Contul tău a fost creat cu succes.\nEmail: ${email}\nPlan: Free\n\nAccesează aplicația aici: ${process.env.FRONTEND_URL || "https://wickandwax.app"}`
    ).catch(() => {});

    res.json({
      access_token: token,
      user: {
        id: userId,
        email,
        full_name: full_name || null,
        plan: "free",
        is_active: true
      }
    });
  } catch (err: any) {
    res.status(500).json({ detail: err.message });
  }
});

app.post("/api/auth/login", (req, res) => {
  try {
    // Support both JSON and form-urlencoded
    const email = req.body.email || req.body.username;
    const password = req.body.password;
    
    const user = db.users.find((u) => u.email === email);
    if (!user || !bcrypt.compareSync(password, user.password)) {
      return res.status(401).json({ detail: "Email sau parolă incorectă" });
    }

    const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: "7d" });
    
    res.json({
      access_token: token,
      user: {
        id: user.id,
        email: user.email,
        full_name: user.full_name,
        plan: user.plan,
        is_active: user.is_active
      }
    });
  } catch (err: any) {
    res.status(500).json({ detail: err.message });
  }
});

app.get("/api/auth/me", authenticateToken, (req: any, res) => {
  try {
    const user = db.users.find((u) => u.id === req.user.userId);
    
    if (!user) {
      return res.status(404).json({ detail: "Utilizator negăsit" });
    }

    res.json({
      id: user.id,
      email: user.email,
      full_name: user.full_name,
      plan: user.plan,
      is_active: user.is_active
    });
  } catch (err: any) {
    res.status(500).json({ detail: err.message });
  }
});

// Plans endpoint
app.get("/api/plans", (req, res) => {
  res.json({ plans: PLANS });
});

// Stripe payment integration
app.post("/api/create-checkout-session", authenticateToken, async (req: any, res) => {
  try {
    const { planId } = req.body;
    const plan = PLANS.find((p) => p.id === planId);

    if (!plan) {
      return res.status(400).json({ detail: "Plan invalid" });
    }

    const user = db.users.find((u) => u.id === req.user.userId);
    if (!user) {
      return res.status(404).json({ detail: "Utilizator negăsit" });
    }

    const origin = req.headers.origin || process.env.FRONTEND_URL || "https://wickandwax.app";

    if (!process.env.STRIPE_SECRET_KEY) {
      user.plan = planId;
      saveDb();
      return res.json({
        success: true,
        planId,
        message: `Planul ${plan.name} a fost activat cu succes!`,
      });
    }

    try {
      const checkoutSession = await stripe.checkout.sessions.create({
        mode: "subscription",
        payment_method_types: ["card"],
        line_items: [
          {
            price_data: {
              currency: plan.currency || "EUR",
              product_data: {
                name: `Wick & Wax ${plan.name}`,
              },
              unit_amount: Math.round((plan.price || 0) * 100),
              recurring: { interval: "month" },
            },
            quantity: 1,
          },
        ],
        success_url: `${origin}/?upgrade=success&plan=${planId}`,
        cancel_url: `${origin}/?upgrade=cancelled`,
        metadata: {
          userId: user.id,
          planId,
        },
      });

      return res.json({ url: checkoutSession.url });
    } catch (stripeErr: any) {
      console.error("Stripe checkout failed, falling back to mock mode:", stripeErr.message);
      user.plan = planId;
      saveDb();
      return res.json({
        success: true,
        planId,
        message: `Planul ${plan.name} a fost activat cu succes! (mod test)`,
      });
    }
  } catch (err: any) {
    console.error("Stripe checkout error:", err);
    res.status(500).json({ detail: err.message || "Eroare la inițierea plății" });
  }
});

async function sendEmail(to: string, subject: string, text: string) {
  try {
    await transporter.sendMail({
      from: process.env.EMAIL_FROM || "Wick & Wax <no-reply@wickandwax.app>",
      to,
      subject,
      text,
      html: text.replace(/\n/g, "<br>"),
    });
  } catch (err) {
    console.error("Email send error:", err);
  }
}

// OpenRouter AI setup
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || process.env.GEMINI_API_KEY || "";
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "google/gemini-2.0-flash-001";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const OPENROUTER_REFERER = process.env.OPENROUTER_REFERER || "https://wickandwax.app";

const aiCache = new Map<string, { ts: number; data: any }>();
const AI_CACHE_TTL_MS = 1000 * 60 * 60;

function aiCacheKey(body: any): string {
  try { return JSON.stringify(body); } catch { return String(body); }
}

async function openRouterChat(messages: Array<{ role: string; content: string }>, userMessage: any): Promise<string> {
  if (!OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY missing");
  }

  const cacheKey = OPENROUTER_MODEL + ":" + aiCacheKey(userMessage);
  const cached = aiCache.get(cacheKey);
  const now = Date.now();
  if (cached && now - cached.ts < AI_CACHE_TTL_MS) {
    return cached.data;
  }

  const response = await fetch(OPENROUTER_BASE_URL + "/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + OPENROUTER_API_KEY,
      "HTTP-Referer": OPENROUTER_REFERER,
      "X-Title": "Wick & Wax Studio",
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      messages,
      temperature: 0.7,
      max_tokens: 1024,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error("OpenRouter error " + response.status + ": " + errText);
  }

  const data = await response.json();
  const reply = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
  aiCache.set(cacheKey, { ts: now, data: reply });
  return reply;
}

// Heuristic fallback for candle composition
function calculateFallbackComposition(data: any) {
  const waxType = data.waxType || "Soy (C3 / Golden Wax 464)";
  const capacityGrams = Number(data.capacityGrams) || 200;
  const jarDiameterMm = Number(data.jarDiameterMm) || 70;
  const throwIntensity = data.throwIntensity || "strong";

  let fragrancePercent = 8;
  if (throwIntensity === "delicate") fragrancePercent = 6;
  else if (throwIntensity === "medium") fragrancePercent = 8;
  else if (throwIntensity === "strong") fragrancePercent = 10;
  else if (throwIntensity === "room-filling") fragrancePercent = 11;

  if (waxType.toLowerCase().includes("beeswax") || waxType.toLowerCase().includes("ceara albine")) {
    fragrancePercent = Math.min(fragrancePercent, 7);
  }

  const fragranceGrams = Math.round((capacityGrams * fragrancePercent) / 100 * 10) / 10;
  const waxGrams = Math.round((capacityGrams - fragranceGrams) * 10) / 10;

  let wick = "TCR 27/16 sau Eco 8 (Bumbac împletit)";
  if (jarDiameterMm < 55) wick = "Eco 4 sau TCR 18/10";
  else if (jarDiameterMm <= 65) wick = "Eco 6 sau TCR 24/12";
  else if (jarDiameterMm <= 75) wick = "Eco 8 sau TCR 27/16";
  else if (jarDiameterMm <= 85) wick = "Eco 10 sau TCR 30/18";
  else if (jarDiameterMm <= 95) wick = "Eco 12 sau Fitil Dublu TCR 21/12";
  else wick = "Fitil Dublu Eco 6 (Multi-wick, spațiu 3.5cm între fitiluri)";

  let meltTemp = "75°C - 80°C";
  let addFragranceTemp = "68°C - 70°C";
  let pourTemp = "52°C - 58°C";
  let cureDays = 14;

  if (waxType.toLowerCase().includes("coconut") || waxType.toLowerCase().includes("cocos")) {
    pourTemp = "48°C - 52°C";
    cureDays = 10;
  } else if (waxType.toLowerCase().includes("beeswax") || waxType.toLowerCase().includes("albine")) {
    pourTemp = "65°C - 70°C";
    cureDays = 7;
  } else if (waxType.toLowerCase().includes("rapeseed") || waxType.toLowerCase().includes("rapita")) {
    pourTemp = "55°C - 60°C";
    cureDays = 12;
  }

  return {
    waxGrams,
    fragranceGrams,
    fragrancePercentage: fragrancePercent,
    recommendedWick: wick,
    meltingTemperature: meltTemp,
    fragranceAddTemperature: addFragranceTemp,
    pourTemperature: pourTemp,
    cureDays,
    fragranceNotes: {
      top: data.topNote || "Citrice proaspete, Bergamotă, Cardamom",
      heart: data.heartNote || "Floare de Portocal, Chihlimbar cald, Lavandă",
      base: data.baseNote || "Lemn de Cedru, Vanilie fină, Mosc alb"
    },
    clpWarnings: "Atenție: Conține substanțe parfumante concentrate. Poate provoca o reacție alergică cutanată. Nociv pentru mediul acvatic cu efecte pe termen lung. Respectați distanța de siguranță de 10cm.",
    safetyIcons: ["flame-sight", "away-from-children", "trim-wick", "draft-free"],
    artisanAdvice: "Preîncălziți ușor borcanul de sticlă la 35°C înainte de turnare pentru a preveni aderența imperfectă și petele de cristalizare (frosting). Asigurați o răcire lentă la temperatura camerei (21-23°C)."
  };
}

function generateFallbackRecipe(data: any): any {
  const inputStr = ((data.prompt || data.scentTheme || "") + " " + (data.tag || "")).toLowerCase();
  const waxType = data.waxType || "Ceară Soia Golden Wax 464";
  const netWeight = Number(data.capacityGrams || data.netWeightGrams) || 220;
  const tag = data.tag || "luxury";
  const jarDiameter = netWeight >= 250 ? 78 : (netWeight <= 160 ? 64 : 72);
  const fragrancePercent = waxType.toLowerCase().includes("beeswax") || waxType.toLowerCase().includes("albine") ? 7 : 10;
  const fragranceGrams = Math.round((netWeight * fragrancePercent) / 100 * 10) / 10;
  const waxGrams = Math.round((netWeight - fragranceGrams) * 10) / 10;

  let nameRo = "Ambră & Rășini de Santal";
  let nameEn = "Amber & Sandalwood Resins";
  let top = "Bergamotă de Calabria, Piper Roz, Cardamom";
  let heart = "Floare de Portocal, Rășină de Smirnă, Nucșoară";
  let base = "Lemn de Santal Indian, Ambră caldă, Mosc alb";

  if (inputStr.includes("craciun") || inputStr.includes("scortisoar") || inputStr.includes("cinnamon") || inputStr.includes("portocal")) {
    nameRo = "Seară de Crăciun & Scorțișoară";
    nameEn = "Christmas Eve & Ceylon Cinnamon";
    top = "Coajă de Portocală confiată, Mandarină însorită";
    heart = "Batoane de Scorțișoară de Ceylon, Cuișoare aromate";
    base = "Măr copt, Lemn de Brad siberian, Păstăi de Vanilie";
  } else if (inputStr.includes("lavand") || inputStr.includes("spa") || inputStr.includes("relax")) {
    nameRo = "Sanctuar de Lavandă & Mușețel";
    nameEn = "Lavender Sanctuary & Roman Chamomile";
    top = "Lavandă sălbatică de Grasse, Frunze de Salvie";
    heart = "Mușețel alb roman, Miere pură de tei";
    base = "Lemn de Cedru nobil, Mosc curat, Boabe de Tonka";
  } else if (inputStr.includes("cafea") || inputStr.includes("espresso") || inputStr.includes("bourbon")) {
    nameRo = "Espresso Velvet & Bourbon Învechit";
    nameEn = "Espresso Velvet & Aged Bourbon";
    top = "Boabe prăjite de Cafea Arabica, Nucă de Macadamia";
    heart = "Bourbon învechit în butoi de stejar, Ciocolată neagră";
    base = "Păstaie de Vanilie bourbon, Caramel sărat, Boabe de Tonka";
  }

  return {
    id: `recipe-${Date.now()}`,
    nameRo,
    nameEn,
    descriptionRo: `O formă regală creată cu rețetă pur vegetală. Notele de ${top.split(",")[0].toLowerCase()} și ${base.split(",")[0].toLowerCase()} învăluie încăperea într-o atmosferă intimă, caldă și catifelată.`,
    descriptionEn: `A royal formulation crafted with pure botanical wax. Notes of ${top.split(",")[0].toLowerCase()} and ${base.split(",")[0].toLowerCase()} wrap the room in an intimate, warm, and velvety atmosphere.`,
    waxType,
    vesselType: netWeight > 230 ? "Borcan Sticlă Mată Neagră 300ml" : "Borcan Sticlă Mată Neagră 250ml",
    netWeightGrams: netWeight,
    jarDiameterMm: jarDiameter,
    burnTimeHours: Math.round(netWeight * 0.22),
    fragranceName: `Esență Concentrată: ${nameRo}`,
    fragrancePercentage: fragrancePercent,
    waxGrams,
    fragranceGrams,
    wickType: "TCR 27/16 (Bumbac împletit)",
    meltTempC: "75°C - 80°C",
    pourTempC: "52°C - 56°C",
    cureDays: 14,
    fragranceNotes: { top, heart, base },
    clpWarningsRo: "Conține: Linalool, Coumarin, Benzyl Benzoate, Eugenol. Poate provoca o reacție alergică a pielii. Nociv pentru mediul acvatic cu efecte pe termen lung.",
    clpWarningsEn: "Contains: Linalool, Coumarin, Benzyl Benzoate, Eugenol. May cause an allergic skin reaction. Harmful to aquatic life with long lasting effects.",
    safetyIcons: ["flame-sight", "away-from-children", "trim-wick", "draft-free"],
    tag,
    baseCost: 26.5,
    recommendedWholesalePrice: 58.0,
    recommendedRetailPrice: 89.0
  };
}

// AI Recipe Generation
app.post("/api/gemini/generate-recipe", authenticateToken, requireAiAccess, async (req, res) => {
  try {
    const { prompt = "", scentTheme = "", waxType = "Ceară Soia Golden Wax 464", netWeightGrams = 220, tag = "luxury", language = "ro" } = req.body;

    if (!OPENROUTER_API_KEY) {
      return res.json(generateFallbackRecipe(req.body));
    }

    const systemPrompt = `You are an elite master candlemaker and perfumer (Maître Cirier & Parfumeur) for the luxury brand "Wick & Wax".
Design a complete, scientifically accurate and opulent luxury scented candle recipe.
Theme / Inspiration: "${prompt || scentTheme || 'Warm Amber, Smoked Cedar & Cashmere'}"
Target Wax: "${waxType}"
Net Candle Weight: ${netWeightGrams}g
Tag: "${tag}" (one of: 'signature', 'seasonal', 'relax', 'luxury', 'fresh')
User UI Language: "${language}"

Return ONLY a valid JSON object strictly matching this schema:
{
  "nameRo": "string luxury evocative name in Romanian",
  "nameEn": "string luxury evocative name in English",
  "nameFr": "string luxury name in French",
  "nameDe": "string luxury name in German",
  "nameIt": "string luxury name in Italian",
  "nameEs": "string luxury name in Spanish",
  "descriptionRo": "string 2-3 poetic sentences describing the olfactory experience in Romanian",
  "descriptionEn": "string 2-3 poetic sentences in English",
  "descriptionFr": "string 2 sentences in French",
  "descriptionDe": "string 2 sentences in German",
  "descriptionIt": "string 2 sentences in Italian",
  "descriptionEs": "string 2 sentences in Spanish",
  "waxType": "${waxType}",
  "vesselType": "string luxury vessel type (e.g. Borcan Sticlă Mată Neagră 250ml)",
  "netWeightGrams": ${netWeightGrams},
  "jarDiameterMm": number (typically 70-82mm for this weight),
  "burnTimeHours": number (approx 0.2-0.24 hours per gram),
  "fragranceName": "string fine fragrance oil name",
  "fragrancePercentage": number (8-11 depending on wax load limit),
  "waxGrams": number,
  "fragranceGrams": number,
  "wickType": "string exact wick code (e.g. TCR 27/16, Eco 8, or Fitil Dublu TCR 21/12)",
  "meltTempC": "string e.g. 75°C - 80°C",
  "pourTempC": "string e.g. 52°C - 56°C",
  "cureDays": number (typically 12-14 for soy, 7-10 for coconut/beeswax)",
  "fragranceNotes": {
    "top": "string 2-3 top notes",
    "heart": "string 2-3 middle/heart notes",
    "base": "string 2-3 lingering base notes"
  },
  "clpWarningsRo": "string CLP regulatory statement mentioning allergen components in Romanian",
  "clpWarningsEn": "string CLP regulatory statement in English",
  "safetyIcons": ["flame-sight", "away-from-children", "trim-wick", "draft-free"],
  "tag": "${tag}",
  "baseCost": number (calculated production cost, around 24-32 RON)",
  "recommendedWholesalePrice": number (around 52-68 RON)",
  "recommendedRetailPrice": number (around 85-115 RON)
}`;

    const reply = await openRouterChat([
      { role: "user", content: systemPrompt },
    ], req.body);

    let parsed = {};
    try {
      const jsonMatch = reply.match(/\{[\s\S]*\}/);
      if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
    } catch {
      parsed = {};
    }

    const recipeId = `recipe-${Date.now()}`;
    const fragrancePct = Number(parsed.fragrancePercentage) || 10;
    const fragranceGrams = Math.round((netWeightGrams * fragrancePct) / 100 * 10) / 10;
    const waxGrams = Math.round((netWeightGrams - fragranceGrams) * 10) / 10;

    const completeRecipe = {
      ...parsed,
      id: recipeId,
      netWeightGrams,
      waxGrams,
      fragranceGrams,
      fragrancePercentage: fragrancePct,
      safetyIcons: Array.isArray(parsed.safetyIcons) ? parsed.safetyIcons : ["flame-sight", "away-from-children", "trim-wick", "draft-safe"],
    };

    res.json(completeRecipe);
  } catch (err: any) {
    console.error("AI recipe generation error (using fallback):", err?.message || err);
    res.json(generateFallbackRecipe(req.body));
  }
});

// AI Composition Suggestion// AI Composition Suggestion
app.post("/api/gemini/suggest-composition", authenticateToken, requireAiAccess, async (req, res) => {
  try {
    const { waxType, capacityGrams, jarDiameterMm, throwIntensity, scentTheme, language = "ro" } = req.body;

    if (!OPENROUTER_API_KEY) {
      return res.json(calculateFallbackComposition(req.body));
    }

    const prompt = `You are a world-class master candle artisan (maître cirier) for the luxury brand "Wick & Wax".
Suggest an exact scientific and sensory candle formulation for:
- Wax: ${waxType || "Soy Wax 464"}
- Total Net Candle Vessel Weight: ${capacityGrams || 200}g
- Jar Inner Diameter: ${jarDiameterMm || 70}mm
- Desired Scent Throw: ${throwIntensity || "strong"}
- Target Scent Theme / Notes: ${scentTheme || "Warm Amber & Cashmere"}
- Preferred Language for output: ${language === "ro" ? "Romanian" : "English"}

Return ONLY a valid JSON object matching this schema:
{
  "waxGrams": number,
  "fragranceGrams": number,
  "fragrancePercentage": number,
  "recommendedWick": "string with specific wick model (e.g. TCR 27/16 or Eco 8 or Wooden Wick 13mm)",
  "meltingTemperature": "string with °C",
  "fragranceAddTemperature": "string with °C (flash point awareness)",
  "pourTemperature": "string with °C",
  "cureDays": number,
  "fragranceNotes": {
    "top": "string",
    "heart": "string",
    "base": "string"
  },
  "clpWarnings": "string CLP regulatory safety statement for label",
  "safetyIcons": ["flame-sight", "away-from-children", "trim-wick", "draft-free"],
  "artisanAdvice": "string 2-3 sentences of expert master-chandler secret for glass adhesion and scent throw"
}`;

    const reply = await openRouterChat([
      { role: "user", content: prompt },
    ], req.body);

    let parsed = {};
    try {
      const jsonMatch = reply.match(/\{[\s\S]*\}/);
      if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
    } catch {
      parsed = {};
    }

    res.json(parsed);
  } catch (err: any) {
    console.error("AI composition error (using fallback):", err?.message || err);
    res.json(calculateFallbackComposition(req.body));
  }
});

// AI Pricing Suggestion
app.post("/api/gemini/suggest-pricing", authenticateToken, requireAiAccess, async (req, res) => {
  try {
    const { unitCost, breakdown, targetMargin = 60, marketPosition = "artisan-luxury", candleName = "Artisan Candle", currency = "RON", language = "ro" } = req.body;

    const baseCost = Number(unitCost) || 25;
    const fallbackWholesale = Math.round(baseCost * 2.1 * 10) / 10;
    const fallbackRetail = Math.round(baseCost * (marketPosition.includes("luxury") ? 3.8 : 3.0) * 10) / 10;

    if (!OPENROUTER_API_KEY) {
      return res.json({
        recommendedWholesalePrice: fallbackWholesale,
        recommendedRetailPrice: fallbackRetail,
        recommendedDirectToConsumerPrice: Math.round(fallbackRetail * 0.95),
        grossMarginPercent: Math.round(((fallbackRetail - baseCost) / fallbackRetail) * 100),
        breakEvenUnits: Math.ceil(400 / (fallbackRetail - baseCost)),
        marketPositioning: marketPosition,
        strategyTip: language === "ro"
          ? "Prețul de retail recomandat asigură o marjă sănătoasă de peste 65%, permițând reduceri promoționale sezoniere fără a eroda profitabilitatea."
          : "Recommended retail pricing ensures a healthy 65%+ gross margin, permitting promotional seasonal campaigns without eroding profit.",
        bundleIdea: language === "ro"
          ? "Pachet 'Duo Lumini & Bețe de Chibrit Elegante' la preț promoțional cu marjă combinată de 72%."
          : "Bundle 'Duo Candles + Luxury Matches' at a promo gift price with 72% blended margin."
      });
    }

    const prompt = `You are a high-end luxury retail pricing strategist for handcrafted boutique candles ("Wick & Wax").
Given:
- Candle Name: ${candleName}
- Total Unit Production Cost: ${baseCost} ${currency}
- Cost Breakdown: ${JSON.stringify(breakdown || {})}
- Target Margin: ${targetMargin}%
- Market Segment: ${marketPosition} (e.g., luxury-niche, artisan-market, clean-eco)
- Language: ${language === "ro" ? "Romanian" : "English"}

Provide structured pricing intelligence. Return ONLY a valid JSON object:
{
  "recommendedWholesalePrice": number,
  "recommendedRetailPrice": number,
  "recommendedDirectToConsumerPrice": number,
  "grossMarginPercent": number,
  "breakEvenUnits": number,
  "marketPositioning": "string",
  "strategyTip": "string with concrete retail psychology advice",
  "bundleIdea": "string gift set or upsell idea"
}`;

    const reply = await openRouterChat([
      { role: "user", content: prompt },
    ], req.body);

    let parsed = {};
    try {
      const jsonMatch = reply.match(/\{[\s\S]*\}/);
      if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
    } catch {
      parsed = {};
    }

    res.json(parsed);
  } catch (err: any) {
    console.error("AI pricing error:", err);
    const baseCost = Number(req.body.unitCost) || 25;
    res.json({
      recommendedWholesalePrice: Math.round(baseCost * 2.1),
      recommendedRetailPrice: Math.round(baseCost * 3.4),
      recommendedDirectToConsumerPrice: Math.round(baseCost * 3.2),
      grossMarginPercent: 68,
      breakEvenUnits: 15,
      marketPositioning: "Artisan Boutique",
      strategyTip: "Prețul reflectă valoarea materiilor prime naturale și manopera de atelier.",
      bundleIdea: "Set cadou de 2 lumânări în cutie cu panglică aurie."
    });
  }
});

// AI Co-Pilot
app.post("/api/gemini/craft-copilot", authenticateToken, requireAiAccess, async (req, res) => {
  try {
    const { query, currentRecipe, currentInventory, language = "ro" } = req.body;

    const fallbackReply = language === "ro"
      ? "Salutare! Sunt Maestrul Tău Meșteșugar Wick & Wax. Pentru a obține cea mai bună aderență a cerii pe sticlă și un parfum uniform, asigură-te că torni la 52-56°C și păstrezi fitilul tăiat la 5mm. Îți pot ajusta orice rețetă sau calcula costurile de producție!"
      : "Greetings! I am your Wick & Wax Master Chandler Assistant. For optimal glass adhesion and smooth scent throw, pour at 52-56°C and keep wicks trimmed to 5mm. I can optimize any recipe or cost structure for you!";

    if (!OPENROUTER_API_KEY) {
      return res.json({ reply: fallbackReply });
    }

    const prompt = `You are the master resident artisan and technical chemist for "Wick & Wax", a high-end candle crafting atelier.
Respond to the candle artisan's inquiry with deep, practical, expert candle-making knowledge (wax melting points, wick sizing, curing times, frosting avoidance, hot & cold throw maximization, IFRA limits, CLP labeling, cost optimization).
Context:
- Current Recipe In Progress: ${JSON.stringify(currentRecipe || {})}
- Current Inventory Highlights: ${JSON.stringify(currentInventory || {})}
- Language: ${language === "ro" ? "Romanian" : "English"}

User Query: "${query}"

Guidelines:
- Tone: Warm, refined, encouraging, highly professional, artisanal luxury.
- Keep the answer structured, actionable, and clear.
- Include concrete numbers (°C, mm, %, days) whenever relevant.`;

    const reply = await openRouterChat([
      { role: "user", content: prompt },
    ], req.body);

    res.json({ reply });
  } catch (err: any) {
    console.error("AI copilot error:", err);
    res.json({
      reply: req.body.language === "en"
        ? "To improve scent throw and prevent tunneling, ensure the melt pool reaches the container edge during burn tests (approx. 1 hour per 25mm diameter), and allow soy wax candles to cure for at least 14 days."
        : "Pentru a maximiza difuzia parfumului și a evita efectul de tunel, asigură-te că bazinul de ceară topită atinge marginile borcanului la primul test de ardere (cca. 1 oră per 25mm diametru), și lasă lumânările din ceară de soia la maturat minim 14 zile."
    });
  }
});

// Store Connections, Suppliers, Purchase Orders

// Store Connections
app.get("/api/stores", authenticateToken, requirePlan("pro"), (req: any, res) => {
  try {
    const stores = db.stores.filter((item) => item.user_id === req.user.userId);
    res.json({ stores: stores.map(s => JSON.parse(s.data)) });
  } catch (err: any) {
    res.status(500).json({ detail: err.message });
  }
});

app.post("/api/stores", authenticateToken, requirePlan("pro"), (req: any, res) => {
  try {
    const storeData = req.body;
    const record: DbRecord = {
      id: `store-${Date.now()}`,
      user_id: req.user.userId,
      data: JSON.stringify(storeData),
      created_at: new Date().toISOString(),
    };
    db.stores.push(record);
    saveDb();
    res.json({ success: true, store: storeData });
  } catch (err: any) {
    res.status(500).json({ detail: err.message });
  }
});

app.put("/api/stores/:id", authenticateToken, requirePlan("pro"), (req: any, res) => {
  try {
    const { id } = req.params;
    const storeData = req.body;
    const record = db.stores.find((item) => item.id === id && item.user_id === req.user.userId);
    if (!record) return res.status(404).json({ detail: "Magazin negăsit" });
    record.data = JSON.stringify(storeData);
    saveDb();
    res.json({ success: true, store: storeData });
  } catch (err: any) {
    res.status(500).json({ detail: err.message });
  }
});

app.delete("/api/stores/:id", authenticateToken, requirePlan("pro"), (req: any, res) => {
  try {
    const { id } = req.params;
    const index = db.stores.findIndex((item) => item.id === id && item.user_id === req.user.userId);
    if (index === -1) return res.status(404).json({ detail: "Magazin negăsit" });
    db.stores.splice(index, 1);
    saveDb();
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ detail: err.message });
  }
});

// Suppliers
app.get("/api/suppliers", authenticateToken, requirePlan("pro"), (req: any, res) => {
  try {
    const records = db.suppliers.filter((item) => item.user_id === req.user.userId);
    res.json({ suppliers: records.map(r => JSON.parse(r.data)) });
  } catch (err: any) {
    res.status(500).json({ detail: err.message });
  }
});

app.post("/api/suppliers", authenticateToken, requirePlan("pro"), (req: any, res) => {
  try {
    const supplierData = req.body;
    const record: DbRecord = {
      id: supplierData.id || `supplier-${Date.now()}`,
      user_id: req.user.userId,
      data: JSON.stringify(supplierData),
      created_at: new Date().toISOString(),
    };
    db.suppliers.push(record);
    saveDb();
    res.json({ success: true, supplier: supplierData });
  } catch (err: any) {
    res.status(500).json({ detail: err.message });
  }
});

app.put("/api/suppliers/:id", authenticateToken, requirePlan("pro"), (req: any, res) => {
  try {
    const { id } = req.params;
    const supplierData = req.body;
    const record = db.suppliers.find((item) => item.id === id && item.user_id === req.user.userId);
    if (!record) return res.status(404).json({ detail: "Furnizor negăsit" });
    record.data = JSON.stringify(supplierData);
    saveDb();
    res.json({ success: true, supplier: supplierData });
  } catch (err: any) {
    res.status(500).json({ detail: err.message });
  }
});

app.delete("/api/suppliers/:id", authenticateToken, requirePlan("pro"), (req: any, res) => {
  try {
    const { id } = req.params;
    const index = db.suppliers.findIndex((item) => item.id === id && item.user_id === req.user.userId);
    if (index === -1) return res.status(404).json({ detail: "Furnizor negăsit" });
    db.suppliers.splice(index, 1);
    saveDb();
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ detail: err.message });
  }
});

// Purchase Orders
app.get("/api/purchase-orders", authenticateToken, requirePlan("pro"), (req: any, res) => {
  try {
    const records = db.purchaseOrders.filter((item) => item.user_id === req.user.userId);
    res.json({ purchaseOrders: records.map(r => JSON.parse(r.data)) });
  } catch (err: any) {
    res.status(500).json({ detail: err.message });
  }
});

app.post("/api/purchase-orders", authenticateToken, requirePlan("pro"), (req: any, res) => {
  try {
    const poData = req.body;
    const record: DbRecord = {
      id: poData.id || `po-${Date.now()}`,
      user_id: req.user.userId,
      data: JSON.stringify(poData),
      created_at: new Date().toISOString(),
    };
    db.purchaseOrders.push(record);
    saveDb();
    res.json({ success: true, purchaseOrder: poData });
  } catch (err: any) {
    res.status(500).json({ detail: err.message });
  }
});

app.put("/api/purchase-orders/:id", authenticateToken, requirePlan("pro"), (req: any, res) => {
  try {
    const { id } = req.params;
    const poData = req.body;
    const record = db.purchaseOrders.find((item) => item.id === id && item.user_id === req.user.userId);
    if (!record) return res.status(404).json({ detail: "Comandă de achiziție negăsită" });
    record.data = JSON.stringify(poData);
    saveDb();
    res.json({ success: true, purchaseOrder: poData });
  } catch (err: any) {
    res.status(500).json({ detail: err.message });
  }
});

app.delete("/api/purchase-orders/:id", authenticateToken, requirePlan("pro"), (req: any, res) => {
  try {
    const { id } = req.params;
    const index = db.purchaseOrders.findIndex((item) => item.id === id && item.user_id === req.user.userId);
    if (index === -1) return res.status(404).json({ detail: "Comandă de achiziție negăsită" });
    db.purchaseOrders.splice(index, 1);
    saveDb();
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ detail: err.message });
  }
});

// Health check - register BEFORE Vite so it is always available
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// Payment Plans
async function seedDatabase() {
  if (db.recipes.length === 0) {
    try {
      const { PREINSTALLED_RECIPES } = await import("./src/data/preinstalledRecipes.ts");
      const testUserIds = db.users.map((u) => u.id);
      for (const userId of testUserIds) {
        for (const recipe of PREINSTALLED_RECIPES) {
          db.recipes.push({ id: `${userId}-${recipe.id}`, user_id: userId, data: JSON.stringify(recipe), created_at: new Date().toISOString() });
        }
      }
      saveDb();
      console.log(`Seeded ${PREINSTALLED_RECIPES.length * testUserIds.length} recipes for ${testUserIds.length} users`);
    } catch (e) { console.error("Failed to seed recipes:", e); }
  }
  if (db.inventory.length === 0) {
    try {
      const { INITIAL_INVENTORY } = await import("./src/data/defaultInventory.ts");
      const testUserIds = db.users.map((u) => u.id);
      for (const userId of testUserIds) {
        for (const item of INITIAL_INVENTORY) {
          db.inventory.push({ id: `${userId}-${item.id}`, user_id: userId, data: JSON.stringify(item), created_at: new Date().toISOString() });
        }
      }
      saveDb();
      console.log(`Seeded ${INITIAL_INVENTORY.length * testUserIds.length} inventory items for ${testUserIds.length} users`);
    } catch (e) { console.error("Failed to seed inventory:", e); }
  }
  if (db.suppliers.length === 0) {
    const defaultSuppliers = [
      { id: "sup-1", name: "CandleWorks Europe", contactName: "Hans Mueller", email: "orders@candleworks.eu", phone: "+49 30 12345678", address: "Industriestr. 45, Berlin, Germany", country: "DE", paymentTerms: "Net 30", leadTimeDays: 5, notes: "Furnizor principal ceară și ambalaje", rating: 4.5, categories: ["wax", "packaging"], isActive: true },
      { id: "sup-2", name: "Wedo Wicks Germania", contactName: "Klaus Weber", email: "verkauf@wedo-wicks.de", phone: "+49 721 98765432", address: "Mühlweg 12, Baden-Württemberg, Germany", country: "DE", paymentTerms: "Net 14", leadTimeDays: 4, notes: "Fitiluri premium pentru lumânări de lux", rating: 5, categories: ["wick"], isActive: true },
      { id: "sup-3", name: "Grasse Parfums Franța", contactName: "Marie Dubois", email: "contact@grasseparfums.fr", phone: "+33 4 93 12 34 56", address: "42 Blvd. Victor Hugo, Grasse, France", country: "FR", paymentTerms: "Net 30", leadTimeDays: 10, notes: "Uleiuri parfumate premium din Grasse", rating: 5, categories: ["fragrance"], isActive: true },
      { id: "sup-4", name: "Vetro Artisans Italia", contactName: "Marco Rossi", email: "info@vetroartisans.it", phone: "+39 02 1234567", address: "Via della Ceramica 8, Murano, Venice, Italy", country: "IT", paymentTerms: "Net 30", leadTimeDays: 7, notes: "Borcane artizanale din sticlă Venetiană", rating: 4, categories: ["vessel"], isActive: true },
    ];
    const testUserIds = db.users.map((u) => u.id);
    for (const userId of testUserIds) {
      for (const sup of defaultSuppliers) {
        db.suppliers.push({ id: `${userId}-${sup.id}`, user_id: userId, data: JSON.stringify(sup), created_at: new Date().toISOString() });
      }
    }
    saveDb();
    console.log(`Seeded ${defaultSuppliers.length * testUserIds.length} suppliers for ${testUserIds.length} users`);
  }
}

// Inventory CRUD
app.get("/api/inventory", authenticateToken, (req: any, res) => {
  try {
    const items = db.inventory.filter((item) => item.user_id === req.user.userId);
    res.json({ inventory: items.map(i => JSON.parse(i.data)) });
  } catch (err: any) {
    res.status(500).json({ detail: err.message });
  }
});

app.post("/api/inventory", authenticateToken, (req: any, res) => {
  try {
    const itemData = req.body;
    const record: DbRecord = {
      id: itemData.id || `inv-${Date.now()}`,
      user_id: req.user.userId,
      data: JSON.stringify(itemData),
      created_at: new Date().toISOString(),
    };
    db.inventory.push(record);
    saveDb();
    res.json({ inventoryItem: itemData });
  } catch (err: any) {
    res.status(500).json({ detail: err.message });
  }
});

app.get("/api/inventory/:id", authenticateToken, (req: any, res) => {
  try {
    const record = db.inventory.find((item) => item.id === req.params.id && item.user_id === req.user.userId);
    if (!record) return res.status(404).json({ detail: "Articol negăsit" });
    res.json({ inventoryItem: JSON.parse(record.data) });
  } catch (err: any) {
    res.status(500).json({ detail: err.message });
  }
});

app.put("/api/inventory/:id", authenticateToken, (req: any, res) => {
  try {
    const record = db.inventory.find((item) => item.id === req.params.id && item.user_id === req.user.userId);
    if (!record) return res.status(404).json({ detail: "Articol negăsit" });
    record.data = JSON.stringify(req.body);
    saveDb();
    res.json({ inventoryItem: req.body });
  } catch (err: any) {
    res.status(500).json({ detail: err.message });
  }
});

app.delete("/api/inventory/:id", authenticateToken, (req: any, res) => {
  try {
    const index = db.inventory.findIndex((item) => item.id === req.params.id && item.user_id === req.user.userId);
    if (index === -1) return res.status(404).json({ detail: "Articol negăsit" });
    db.inventory.splice(index, 1);
    saveDb();
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ detail: err.message });
  }
});

// Orders CRUD
app.get("/api/orders", authenticateToken, (req: any, res) => {
  try {
    const records = db.orders.filter((item) => item.user_id === req.user.userId);
    res.json({ orders: records.map(r => JSON.parse(r.data)) });
  } catch (err: any) {
    res.status(500).json({ detail: err.message });
  }
});

app.post("/api/orders", authenticateToken, (req: any, res) => {
  try {
    const orderData = req.body;
    const record: DbRecord = {
      id: orderData.id || `ord-${Date.now()}`,
      user_id: req.user.userId,
      data: JSON.stringify(orderData),
      created_at: new Date().toISOString(),
    };
    db.orders.push(record);
    saveDb();
    res.json({ order: orderData });
  } catch (err: any) {
    res.status(500).json({ detail: err.message });
  }
});

app.get("/api/orders/:id", authenticateToken, (req: any, res) => {
  try {
    const record = db.orders.find((item) => item.id === req.params.id && item.user_id === req.user.userId);
    if (!record) return res.status(404).json({ detail: "Comandă negăsită" });
    res.json({ order: JSON.parse(record.data) });
  } catch (err: any) {
    res.status(500).json({ detail: err.message });
  }
});

app.put("/api/orders/:id", authenticateToken, (req: any, res) => {
  try {
    const record = db.orders.find((item) => item.id === req.params.id && item.user_id === req.user.userId);
    if (!record) return res.status(404).json({ detail: "Comandă negăsită" });
    record.data = JSON.stringify(req.body);
    saveDb();
    res.json({ order: req.body });
  } catch (err: any) {
    res.status(500).json({ detail: err.message });
  }
});

app.delete("/api/orders/:id", authenticateToken, (req: any, res) => {
  try {
    const index = db.orders.findIndex((item) => item.id === req.params.id && item.user_id === req.user.userId);
    if (index === -1) return res.status(404).json({ detail: "Comandă negăsită" });
    db.orders.splice(index, 1);
    saveDb();
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ detail: err.message });
  }
});

// Recipes CRUD
app.get("/api/recipes", authenticateToken, (req: any, res) => {
  try {
    const records = db.recipes.filter((item) => item.user_id === req.user.userId);
    res.json({ recipes: records.map(r => JSON.parse(r.data)) });
  } catch (err: any) {
    res.status(500).json({ detail: err.message });
  }
});

app.post("/api/recipes", authenticateToken, (req: any, res) => {
  try {
    const recipeData = req.body;
    const record: DbRecord = {
      id: recipeData.id || `recipe-${Date.now()}`,
      user_id: req.user.userId,
      data: JSON.stringify(recipeData),
      created_at: new Date().toISOString(),
    };
    db.recipes.push(record);
    saveDb();
    res.json({ recipe: recipeData });
  } catch (err: any) {
    res.status(500).json({ detail: err.message });
  }
});

app.get("/api/recipes/:id", authenticateToken, (req: any, res) => {
  try {
    const record = db.recipes.find((item) => item.id === req.params.id && item.user_id === req.user.userId);
    if (!record) return res.status(404).json({ detail: "Rețetă negăsită" });
    res.json({ recipe: JSON.parse(record.data) });
  } catch (err: any) {
    res.status(500).json({ detail: err.message });
  }
});

app.put("/api/recipes/:id", authenticateToken, (req: any, res) => {
  try {
    const record = db.recipes.find((item) => item.id === req.params.id && item.user_id === req.user.userId);
    if (!record) return res.status(404).json({ detail: "Rețetă negăsită" });
    record.data = JSON.stringify(req.body);
    saveDb();
    res.json({ recipe: req.body });
  } catch (err: any) {
    res.status(500).json({ detail: err.message });
  }
});

app.delete("/api/recipes/:id", authenticateToken, (req: any, res) => {
  try {
    const index = db.recipes.findIndex((item) => item.id === req.params.id && item.user_id === req.user.userId);
    if (index === -1) return res.status(404).json({ detail: "Rețetă negăsită" });
    db.recipes.splice(index, 1);
    saveDb();
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ detail: err.message });
  }
});

// Calendar Events CRUD
app.get("/api/calendar", authenticateToken, (req: any, res) => {
  try {
    const records = db.calendarEvents.filter((item) => item.user_id === req.user.userId);
    res.json({ events: records.map(r => JSON.parse(r.data)) });
  } catch (err: any) {
    res.status(500).json({ detail: err.message });
  }
});

app.post("/api/calendar", authenticateToken, (req: any, res) => {
  try {
    const eventData = req.body;
    const record: DbRecord = {
      id: eventData.id || `ev-${Date.now()}`,
      user_id: req.user.userId,
      data: JSON.stringify(eventData),
      created_at: new Date().toISOString(),
    };
    db.calendarEvents.push(record);
    saveDb();
    res.json({ event: eventData });
  } catch (err: any) {
    res.status(500).json({ detail: err.message });
  }
});

app.get("/api/calendar/:id", authenticateToken, (req: any, res) => {
  try {
    const record = db.calendarEvents.find((item) => item.id === req.params.id && item.user_id === req.user.userId);
    if (!record) return res.status(404).json({ detail: "Eveniment negăsit" });
    res.json({ event: JSON.parse(record.data) });
  } catch (err: any) {
    res.status(500).json({ detail: err.message });
  }
});

app.put("/api/calendar/:id", authenticateToken, (req: any, res) => {
  try {
    const record = db.calendarEvents.find((item) => item.id === req.params.id && item.user_id === req.user.userId);
    if (!record) return res.status(404).json({ detail: "Eveniment negăsit" });
    record.data = JSON.stringify(req.body);
    saveDb();
    res.json({ event: req.body });
  } catch (err: any) {
    res.status(500).json({ detail: err.message });
  }
});

app.delete("/api/calendar/:id", authenticateToken, (req: any, res) => {
  try {
    const index = db.calendarEvents.findIndex((item) => item.id === req.params.id && item.user_id === req.user.userId);
    if (index === -1) return res.status(404).json({ detail: "Eveniment negăsit" });
    db.calendarEvents.splice(index, 1);
    saveDb();
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ detail: err.message });
  }
});

// Labels CRUD
app.get("/api/labels", authenticateToken, (req: any, res) => {
  try {
    const records = db.labels.filter((item) => item.user_id === req.user.userId);
    res.json({ labels: records.map(r => JSON.parse(r.data)) });
  } catch (err: any) {
    res.status(500).json({ detail: err.message });
  }
});

app.post("/api/labels", authenticateToken, (req: any, res) => {
  try {
    const labelData = req.body;
    const record: DbRecord = {
      id: labelData.id || `label-${Date.now()}`,
      user_id: req.user.userId,
      data: JSON.stringify(labelData),
      created_at: new Date().toISOString(),
    };
    db.labels.push(record);
    saveDb();
    res.json({ label: labelData });
  } catch (err: any) {
    res.status(500).json({ detail: err.message });
  }
});

// ============================================================
// BATCH PRODUCTION TRACKING
// ============================================================
app.get("/api/batches", authenticateToken, requirePlan("pro"), (req: any, res) => {
  try {
    const records = db.batches?.filter((item: any) => item.user_id === req.user.userId) || [];
    res.json({ batches: records.map(r => JSON.parse(r.data)) });
  } catch (err: any) {
    res.status(500).json({ detail: err.message });
  }
});

app.post("/api/batches", authenticateToken, requirePlan("pro"), (req: any, res) => {
  try {
    const batchData = req.body;
    const record: any = {
      id: batchData.id || `batch-${Date.now()}`,
      user_id: req.user.userId,
      data: JSON.stringify(batchData),
      created_at: new Date().toISOString(),
    };
    if (!db.batches) db.batches = [];
    db.batches.push(record);
    saveDb();
    res.json({ batch: batchData });
  } catch (err: any) {
    res.status(500).json({ detail: err.message });
  }
});

app.put("/api/batches/:id", authenticateToken, requirePlan("pro"), (req: any, res) => {
  try {
    const record = db.batches?.find((item: any) => item.id === req.params.id && item.user_id === req.user.userId);
    if (!record) return res.status(404).json({ detail: "Batch negăsit" });
    record.data = JSON.stringify(req.body);
    saveDb();
    res.json({ batch: req.body });
  } catch (err: any) {
    res.status(500).json({ detail: err.message });
  }
});

app.delete("/api/batches/:id", authenticateToken, requirePlan("pro"), (req: any, res) => {
  try {
    const index = db.batches?.findIndex((item: any) => item.id === req.params.id && item.user_id === req.user.userId);
    if (index === undefined || index === -1) return res.status(404).json({ detail: "Batch negăsit" });
    db.batches.splice(index, 1);
    saveDb();
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ detail: err.message });
  }
});

// ============================================================
// BURN TEST LOGGING
// ============================================================
app.get("/api/burn-tests", authenticateToken, requirePlan("pro"), (req: any, res) => {
  try {
    const records = db.burnTests?.filter((item: any) => item.user_id === req.user.userId) || [];
    res.json({ burnTests: records.map(r => JSON.parse(r.data)) });
  } catch (err: any) {
    res.status(500).json({ detail: err.message });
  }
});

app.post("/api/burn-tests", authenticateToken, requirePlan("pro"), (req: any, res) => {
  try {
    const testData = req.body;
    const record: any = {
      id: testData.id || `burn-${Date.now()}`,
      user_id: req.user.userId,
      data: JSON.stringify(testData),
      created_at: new Date().toISOString(),
    };
    if (!db.burnTests) db.burnTests = [];
    db.burnTests.push(record);
    saveDb();
    res.json({ burnTest: testData });
  } catch (err: any) {
    res.status(500).json({ detail: err.message });
  }
});

app.get("/api/recipes/:id/burn-tests", authenticateToken, requirePlan("pro"), (req: any, res) => {
  try {
    const records = db.burnTests?.filter((item: any) => item.user_id === req.user.userId && JSON.parse(item.data).recipeId === req.params.id) || [];
    res.json({ burnTests: records.map(r => JSON.parse(r.data)) });
  } catch (err: any) {
    res.status(500).json({ detail: err.message });
  }
});

// ============================================================
// BUSINESS LEDGER
// ============================================================
app.get("/api/ledger", authenticateToken, requirePlan("business"), (req: any, res) => {
  try {
    const records = db.ledger?.filter((item: any) => item.user_id === req.user.userId) || [];
    res.json({ ledger: records.map(r => JSON.parse(r.data)) });
  } catch (err: any) {
    res.status(500).json({ detail: err.message });
  }
});

app.post("/api/ledger", authenticateToken, requirePlan("business"), (req: any, res) => {
  try {
    const entryData = req.body;
    const record: any = {
      id: entryData.id || `ledger-${Date.now()}`,
      user_id: req.user.userId,
      data: JSON.stringify(entryData),
      created_at: new Date().toISOString(),
    };
    if (!db.ledger) db.ledger = [];
    db.ledger.push(record);
    saveDb();
    res.json({ entry: entryData });
  } catch (err: any) {
    res.status(500).json({ detail: err.message });
  }
});

app.get("/api/ledger/summary", authenticateToken, requirePlan("business"), (req: any, res) => {
  try {
    const records = db.ledger?.filter((item: any) => item.user_id === req.user.userId) || [];
    const entries = records.map(r => JSON.parse(r.data));
    const totalIncome = entries.filter((e: any) => e.type === 'income').reduce((sum: number, e: any) => sum + e.amount, 0);
    const totalExpenses = entries.filter((e: any) => e.type === 'expense').reduce((sum: number, e: any) => sum + e.amount, 0);
    const netProfit = totalIncome - totalExpenses;
    const profitMargin = totalIncome > 0 ? ((netProfit / totalIncome) * 100) : 0;
    const taxEstimate = netProfit > 0 ? netProfit * 0.16 : 0;
    res.json({ totalIncome, totalExpenses, netProfit, profitMargin, taxEstimate });
  } catch (err: any) {
    res.status(500).json({ detail: err.message });
  }
});

// ============================================================
// EVENT TRACKING
// ============================================================
app.get("/api/events", authenticateToken, requirePlan("business"), (req: any, res) => {
  try {
    const records = db.events?.filter((item: any) => item.user_id === req.user.userId) || [];
    res.json({ events: records.map(r => JSON.parse(r.data)) });
  } catch (err: any) {
    res.status(500).json({ detail: err.message });
  }
});

app.post("/api/events", authenticateToken, requirePlan("business"), (req: any, res) => {
  try {
    const eventData = req.body;
    const record: any = {
      id: eventData.id || `evt-${Date.now()}`,
      user_id: req.user.userId,
      data: JSON.stringify(eventData),
      created_at: new Date().toISOString(),
    };
    if (!db.events) db.events = [];
    db.events.push(record);
    saveDb();
    res.json({ event: eventData });
  } catch (err: any) {
    res.status(500).json({ detail: err.message });
  }
});

app.put("/api/events/:id", authenticateToken, requirePlan("business"), (req: any, res) => {
  try {
    const record = db.events?.find((item: any) => item.id === req.params.id && item.user_id === req.user.userId);
    if (!record) return res.status(404).json({ detail: "Eveniment negăsit" });
    record.data = JSON.stringify(req.body);
    saveDb();
    res.json({ event: req.body });
  } catch (err: any) {
    res.status(500).json({ detail: err.message });
  }
});

app.delete("/api/events/:id", authenticateToken, requirePlan("business"), (req: any, res) => {
  try {
    const index = db.events?.findIndex((item: any) => item.id === req.params.id && item.user_id === req.user.userId);
    if (index === undefined || index === -1) return res.status(404).json({ detail: "Eveniment negăsit" });
    db.events.splice(index, 1);
    saveDb();
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ detail: err.message });
  }
});

// ============================================================
// RECIPE VERSIONING
// ============================================================
app.get("/api/recipes/:id/versions", authenticateToken, (req: any, res) => {
  try {
    const records = db.recipeVersions?.filter((item: any) => item.user_id === req.user.userId && JSON.parse(item.data).recipeId === req.params.id) || [];
    res.json({ versions: records.map(r => JSON.parse(r.data)) });
  } catch (err: any) {
    res.status(500).json({ detail: err.message });
  }
});

app.post("/api/recipes/:id/versions", authenticateToken, (req: any, res) => {
  try {
    const versionData = req.body;
    const record: any = {
      id: versionData.id || `ver-${Date.now()}`,
      user_id: req.user.userId,
      data: JSON.stringify(versionData),
      created_at: new Date().toISOString(),
    };
    if (!db.recipeVersions) db.recipeVersions = [];
    db.recipeVersions.push(record);
    saveDb();
    res.json({ version: versionData });
  } catch (err: any) {
    res.status(500).json({ detail: err.message });
  }
});

// ============================================================
// SKU / BARCODE
// ============================================================
app.get("/api/sku-barcodes", authenticateToken, requirePlan("pro"), (req: any, res) => {
  try {
    const records = db.skuBarcodes?.filter((item: any) => item.user_id === req.user.userId) || [];
    res.json({ skuBarcodes: records.map(r => JSON.parse(r.data)) });
  } catch (err: any) {
    res.status(500).json({ detail: err.message });
  }
});

app.post("/api/sku-barcodes", authenticateToken, requirePlan("pro"), (req: any, res) => {
  try {
    const skuData = req.body;
    const record: any = {
      id: skuData.id || `sku-${Date.now()}`,
      user_id: req.user.userId,
      data: JSON.stringify(skuData),
      created_at: new Date().toISOString(),
    };
    if (!db.skuBarcodes) db.skuBarcodes = [];
    db.skuBarcodes.push(record);
    saveDb();
    res.json({ skuBarcode: skuData });
  } catch (err: any) {
    res.status(500).json({ detail: err.message });
  }
});

// AI Chat endpoint (alias for craft-copilot)
app.post("/api/ai-chat", authenticateToken, requireAiAccess, async (req, res) => {
  try {
    const { query, currentRecipe, currentInventory, language = "ro" } = req.body;

    const fallbackReply = language === "ro"
      ? "Salutare! Sunt Maestrul Tău Meșteșugar Wick & Wax. Cum te pot ajuta astăzi?"
      : "Greetings! I am your Wick & Wax Master Chandler Assistant. How may I assist you today?";

    if (!OPENROUTER_API_KEY) {
      return res.json({ reply: fallbackReply });
    }

    const prompt = `You are the master resident artisan for "Wick & Wax".\nContext:\n- Current Recipe In Progress: ${JSON.stringify(currentRecipe || {})}\n- Current Inventory Highlights: ${JSON.stringify(currentInventory || {})}\n- Language: ${language === "ro" ? "Romanian" : "English"}\n\nUser Query: "${query}"\n\nGuidelines:\n- Tone: Warm, refined, encouraging, highly professional, artisanal luxury.\n- Keep the answer structured, actionable, and clear.\n- Include concrete numbers (°C, mm, %, days) whenever relevant.`;

    const reply = await openRouterChat([
      { role: "user", content: prompt },
    ], req.body);

    res.json({ reply });
  } catch (err: any) {
    console.error("AI chat error:", err);
    res.json({ reply: req.body.language === "en" ? "I'm here to help with your candle-making questions. Please try again." : "Sunt aici să te ajut cu întrebările despre fabricarea lumânărilor. Te rog încearcă din nou." });
  }
});

// Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Password reset
app.post("/api/auth/forgot-password", (req, res) => {
  try {
    const { email } = req.body || {};
    const user = db.users.find((u) => u.email === email);
    if (!user) {
      return res.json({ detail: "Dacă emailul există, vei primi instrucțiuni de resetare." });
    }

    const resetToken = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: "15m" });
    user.resetPasswordToken = resetToken;
    user.resetPasswordExpires = Date.now() + 15 * 60 * 1000;
    saveDb();

    const resetUrl = `${process.env.FRONTEND_URL || "https://wickandwax.app"}/reset-password?token=${resetToken}`;
    sendEmail(email, "Resetare parolă - Wick & Wax", `Accesează acest link pentru a-ți reseta parola:\n${resetUrl}\n\nLinkul expiră în 15 minute.`).catch(() => {});

    res.json({ detail: "Dacă emailul există, vei primi instrucțiuni de resetare." });
  } catch (err: any) {
    res.status(500).json({ detail: err.message });
  }
});

app.post("/api/auth/reset-password", (req, res) => {
  try {
    const { token, password } = req.body || {};
    let decoded: any;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch (e) {
      return res.status(400).json({ detail: "Token invalid sau expirat" });
    }

    const user = db.users.find((u) => u.id === decoded.userId);
    if (!user || user.resetPasswordExpires < Date.now()) {
      return res.status(400).json({ detail: "Token invalid sau expirat" });
    }

    user.password = bcrypt.hashSync(password, 10);
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;
    saveDb();

    res.json({ detail: "Parola a fost actualizată cu succes" });
  } catch (err: any) {
    res.status(500).json({ detail: err.message });
  }
});

// Stripe webhook
app.post("/api/webhooks/stripe", express.raw({ type: "application/json" }), async (req: any, res) => {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    if (!process.env.STRIPE_WEBHOOK_SECRET || !sig) {
      return res.status(400).json({ detail: "Webhook secret sau semnătură lipsă" });
    }

    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err: any) {
    console.error("Stripe webhook signature error:", err);
    return res.status(400).json({ detail: `Invalid signature: ${err.message}` });
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object as any;
    const userId = session.metadata?.userId;
    const planId = session.metadata?.planId;

    if (userId && planId) {
      const user = db.users.find((u) => u.id === userId);
      if (user) {
        user.plan = planId;
        saveDb();
        console.log(`✅ Plan actualizat automat pentru ${user.email}: ${planId}`);
      }
    }
  }

  res.json({ received: true });
});

// Vite Middleware
async function startServer() {
  const isProd = process.env.NODE_ENV === "production";

  if (!isProd) {
    try {
      const { createServer: createViteServer } = await import("vite");
      const vite = await createViteServer({
        server: { middlewareMode: true },
        appType: "spa",
      });
      app.use(vite.middlewares);
      console.log("✅ Vite dev middleware attached");
    } catch (viteErr) {
      console.error("❌ Failed to start Vite dev middleware:", viteErr);
      // Continue without Vite so the API is still reachable
    }
  } else {
    app.use(express.static(path.resolve(__dirname, "dist")));
    app.get("*", (_req, res) => {
      res.sendFile(path.resolve(__dirname, "dist", "index.html"));
    });
  }

  const server = app.listen(PORT, "0.0.0.0", async () => {
    console.log(`🕯️  Wick & Wax Studio server running at http://0.0.0.0:${PORT}`);
    await seedDatabase();
    console.log("🌱 Database seeding complete");
  });

  server.on("error", (err: any) => {
    console.error("❌ Server error:", err.message);
    if (err.code === "EADDRINUSE") {
      console.error(`   Port ${PORT} is already in use. Kill the process on that port and retry.`);
    }
  });

  return server;
}

// Global error handlers so the process does not crash silently
process.on("uncaughtException", (err) => {
  console.error("❌ Uncaught exception:", err);
  process.exitCode = 1;
});

process.on("unhandledRejection", (reason) => {
  console.error("❌ Unhandled rejection:", reason);
  process.exitCode = 1;
});

startServer().catch((err) => {
  console.error("❌ Failed to start Wick & Wax server:", err);
  process.exit(1);
});
