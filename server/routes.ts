import { Router } from "express";
import bcrypt from "bcryptjs";
import { generateSecret, verify, generateURI } from "otplib";
import qrcode from "qrcode";
import crypto from "crypto";
import db from "./db";
import { authMiddleware, generateToken } from "./auth";
import { sendEmail } from "./mailer";
import { analyzeBookBackend } from "./gemini";

const router = Router();

// --- GEMINI ANALYSIS ---
router.post("/analyze", authMiddleware, async (req, res) => {
  console.log("[API /analyze] Request received");
  try {
    const { content } = req.body;
    if (!content) {
      return res.status(400).json({ error: "Content is required" });
    }
    
    const jobId = crypto.randomUUID();
    db.prepare("INSERT INTO analysis_jobs (id, status, progress) VALUES (?, ?, ?)").run(jobId, 'processing', 0);
    
    // Start analysis in background
    (async () => {
      try {
        const analysis = await analyzeBookBackend(content, (progress, message) => {
          db.prepare("UPDATE analysis_jobs SET progress = ?, message = ? WHERE id = ?").run(progress, message, jobId);
        });
        db.prepare("UPDATE analysis_jobs SET status = ?, progress = 100, message = ?, result = ? WHERE id = ?").run('completed', 'Finalizado', JSON.stringify(analysis), jobId);
      } catch (err: any) {
        console.error(`[Job ${jobId}] Error:`, err);
        db.prepare("UPDATE analysis_jobs SET status = ?, error = ? WHERE id = ?").run('failed', err.message, jobId);
      }
    })();

    res.json({ jobId });
  } catch (err: any) {
    console.error("[API /analyze] Error starting job:", err);
    res.status(500).json({ error: "Error starting analysis" });
  }
});

router.get("/analysis-status/:jobId", authMiddleware, (req, res) => {
  const job = db.prepare("SELECT * FROM analysis_jobs WHERE id = ?").get(req.params.jobId) as any;
  if (!job) return res.status(404).json({ error: "Job not found" });
  
  if (job.status === 'completed') {
    res.json({ status: job.status, progress: job.progress, message: job.message, result: JSON.parse(job.result) });
  } else if (job.status === 'failed') {
    res.json({ status: job.status, progress: job.progress, message: job.message, error: job.error });
  } else {
    res.json({ status: job.status, progress: job.progress, message: job.message });
  }
});

// --- AUTHENTICATION ---

router.post("/auth/register", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email and password required" });

  try {
    const hash = await bcrypt.hash(password, 10);
    const secret = generateSecret();
    
    const stmt = db.prepare("INSERT INTO users (email, password_hash, totp_secret) VALUES (?, ?, ?)");
    const result = stmt.run(email, hash, secret);
    const userId = result.lastInsertRowid;

    // Create default library
    const libStmt = db.prepare("INSERT INTO libraries (name, owner_id) VALUES (?, ?)");
    const libResult = libStmt.run("Mi Biblioteca Principal", userId);
    
    db.prepare("INSERT INTO library_users (library_id, user_id, role) VALUES (?, ?, ?)").run(libResult.lastInsertRowid, userId, "owner");

    res.json({ message: "User registered successfully", userId });
  } catch (err: any) {
    if (err.code === "SQLITE_CONSTRAINT_UNIQUE") {
      return res.status(400).json({ error: "Email already exists" });
    }
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/auth/login", async (req, res) => {
  const { email, password, totpToken } = req.body;
  
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email) as any;
  if (!user) return res.status(401).json({ error: "Invalid credentials" });

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: "Invalid credentials" });

  if (user.is_totp_enabled) {
    if (!totpToken) {
      return res.json({ require2FA: true, userId: user.id });
    }
    const isValidTotp = verify({ token: totpToken, secret: user.totp_secret });
    if (!isValidTotp) return res.status(401).json({ error: "Invalid 2FA code" });
  }

  const token = generateToken(user.id);
  res.json({ token, user: { id: user.id, email: user.email, is_totp_enabled: user.is_totp_enabled } });
});

router.post("/auth/verify-2fa", async (req, res) => {
  const { userId, totpToken } = req.body;
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as any;
  if (!user) return res.status(404).json({ error: "User not found" });

  const isValidTotp = verify({ token: totpToken, secret: user.totp_secret });
  if (!isValidTotp) return res.status(401).json({ error: "Invalid 2FA code" });

  const token = generateToken(user.id);
  res.json({ token, user: { id: user.id, email: user.email, is_totp_enabled: user.is_totp_enabled } });
});

router.get("/auth/2fa/setup", authMiddleware, async (req: any, res) => {
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.userId) as any;
  if (!user) return res.status(404).json({ error: "User not found" });

  const otpauth = generateURI({ label: user.email, issuer: "Bookreminder", secret: user.totp_secret });
  const qrCodeUrl = await qrcode.toDataURL(otpauth);
  
  res.json({ qrCodeUrl, secret: user.totp_secret });
});

router.post("/auth/2fa/enable", authMiddleware, async (req: any, res) => {
  const { token } = req.body;
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.userId) as any;
  
  const isValid = verify({ token, secret: user.totp_secret });
  if (!isValid) return res.status(400).json({ error: "Invalid token" });

  db.prepare("UPDATE users SET is_totp_enabled = 1 WHERE id = ?").run(req.userId);
  res.json({ success: true });
});

router.post("/auth/guest", async (req, res) => {
  try {
    const randomHex = crypto.randomBytes(4).toString("hex");
    const email = `guest_${randomHex}@bookreminder.local`;
    const password = crypto.randomBytes(16).toString("hex");
    const hash = await bcrypt.hash(password, 10);
    const secret = generateSecret();
    
    const stmt = db.prepare("INSERT INTO users (email, password_hash, totp_secret) VALUES (?, ?, ?)");
    const result = stmt.run(email, hash, secret);
    const userId = result.lastInsertRowid;

    // Create default library for guest
    const libStmt = db.prepare("INSERT INTO libraries (name, owner_id) VALUES (?, ?)");
    const libResult = libStmt.run("Biblioteca de Invitado", userId);
    
    db.prepare("INSERT INTO library_users (library_id, user_id, role) VALUES (?, ?, ?)").run(libResult.lastInsertRowid, userId, "owner");

    const token = generateToken(userId as number);
    res.json({ token, user: { id: userId, email, is_totp_enabled: 0 } });
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
});

// --- PASSWORD RECOVERY ---

router.post("/auth/forgot-password", async (req, res) => {
  const { email } = req.body;
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email) as any;
  if (!user) return res.json({ success: true }); // Don't reveal if user exists

  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 3600000).toISOString(); // 1 hour
  
  db.prepare("INSERT INTO password_resets (user_id, token, expires_at) VALUES (?, ?, ?)").run(user.id, token, expiresAt);

  const resetUrl = `${process.env.APP_URL || 'http://localhost:3000'}/reset-password?token=${token}`;
  
  await sendEmail(
    email, 
    "Recuperación de contraseña - Bookreminder", 
    `<p>Has solicitado restablecer tu contraseña.</p><p>Haz clic en el siguiente enlace para crear una nueva:</p><a href="${resetUrl}">Restablecer Contraseña</a>`
  );

  res.json({ success: true });
});

router.post("/auth/reset-password", async (req, res) => {
  const { token, newPassword } = req.body;
  
  const reset = db.prepare("SELECT * FROM password_resets WHERE token = ? AND expires_at > ?").get(token, new Date().toISOString()) as any;
  if (!reset) return res.status(400).json({ error: "Invalid or expired token" });

  const hash = await bcrypt.hash(newPassword, 10);
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, reset.user_id);
  db.prepare("DELETE FROM password_resets WHERE id = ?").run(reset.id);

  res.json({ success: true });
});

// --- LIBRARIES ---

router.get("/libraries", authMiddleware, (req: any, res) => {
  const libraries = db.prepare(`
    SELECT l.*, lu.role 
    FROM libraries l 
    JOIN library_users lu ON l.id = lu.library_id 
    WHERE lu.user_id = ?
  `).all(req.userId);
  res.json(libraries);
});

router.post("/libraries", authMiddleware, (req: any, res) => {
  const { name } = req.body;
  const stmt = db.prepare("INSERT INTO libraries (name, owner_id) VALUES (?, ?)");
  const result = stmt.run(name, req.userId);
  const libId = result.lastInsertRowid;
  
  db.prepare("INSERT INTO library_users (library_id, user_id, role) VALUES (?, ?, ?)").run(libId, req.userId, "owner");
  
  res.json({ id: libId, name, role: "owner" });
});

// --- SHARING ---

router.post("/libraries/:id/invite", authMiddleware, async (req: any, res) => {
  const libraryId = req.params.id;
  const { email, role } = req.body; // role: editor, viewer
  
  // Check if user is owner
  const userRole = db.prepare("SELECT role FROM library_users WHERE library_id = ? AND user_id = ?").get(libraryId, req.userId) as any;
  if (!userRole || userRole.role !== 'owner') return res.status(403).json({ error: "Only owners can invite" });

  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 7 * 24 * 3600000).toISOString(); // 7 days
  
  db.prepare("INSERT INTO library_invitations (library_id, email, token, role, expires_at) VALUES (?, ?, ?, ?, ?)").run(libraryId, email, token, role, expiresAt);

  const library = db.prepare("SELECT name FROM libraries WHERE id = ?").get(libraryId) as any;
  const inviteUrl = `${process.env.APP_URL || 'http://localhost:3000'}/accept-invite?token=${token}`;
  
  await sendEmail(
    email, 
    `Invitación a biblioteca: ${library.name}`, 
    `<p>Te han invitado a colaborar en la biblioteca <b>${library.name}</b> en Bookreminder.</p><p>Haz clic en el siguiente enlace para aceptar la invitación:</p><a href="${inviteUrl}">Aceptar Invitación</a>`
  );

  res.json({ success: true });
});

router.post("/libraries/accept-invite", authMiddleware, (req: any, res) => {
  const { token } = req.body;
  
  const invite = db.prepare("SELECT * FROM library_invitations WHERE token = ? AND expires_at > ?").get(token, new Date().toISOString()) as any;
  if (!invite) return res.status(400).json({ error: "Invalid or expired invite" });

  const user = db.prepare("SELECT email FROM users WHERE id = ?").get(req.userId) as any;
  if (user.email !== invite.email) return res.status(403).json({ error: "Email mismatch" });

  try {
    db.prepare("INSERT INTO library_users (library_id, user_id, role) VALUES (?, ?, ?)").run(invite.library_id, req.userId, invite.role);
  } catch (e) {
    // Ignore if already in library
  }
  
  db.prepare("DELETE FROM library_invitations WHERE id = ?").run(invite.id);

  res.json({ success: true, libraryId: invite.library_id });
});

// --- BOOKS ---

router.get("/libraries/:id/books", authMiddleware, (req: any, res) => {
  const libraryId = req.params.id;
  
  // Check access
  const access = db.prepare("SELECT role FROM library_users WHERE library_id = ? AND user_id = ?").get(libraryId, req.userId);
  if (!access) return res.status(403).json({ error: "Access denied" });

  const books = db.prepare("SELECT * FROM books WHERE library_id = ? ORDER BY created_at DESC").all(libraryId);
  res.json(books);
});

router.post("/libraries/:id/books", authMiddleware, (req: any, res) => {
  const libraryId = req.params.id;
  
  // Check access
  const access = db.prepare("SELECT role FROM library_users WHERE library_id = ? AND user_id = ?").get(libraryId, req.userId) as any;
  if (!access || access.role === 'viewer') return res.status(403).json({ error: "Access denied" });

  const { 
    titulo, autor, isbn, sinopsis, biografia_autor, bibliografia_autor,
    datos_publicacion, resumen_general, resumen_detallado_capitulos,
    resumen_capitulos, analisis_personajes, 
    evolucion_protagonista, mermaid_code, guion_podcast_personajes, guion_podcast_libro 
  } = req.body;

  const stmt = db.prepare(`
    INSERT INTO books (
      library_id, titulo, autor, isbn, sinopsis, biografia_autor, bibliografia_autor,
      datos_publicacion, resumen_general, resumen_detallado_capitulos,
      resumen_capitulos, analisis_personajes, 
      evolucion_protagonista, mermaid_code, guion_podcast_personajes, guion_podcast_libro
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    libraryId, titulo, autor, isbn, sinopsis, biografia_autor, bibliografia_autor,
    datos_publicacion, resumen_general, resumen_detallado_capitulos,
    resumen_capitulos, analisis_personajes, 
    evolucion_protagonista, mermaid_code, guion_podcast_personajes, guion_podcast_libro
  );

  res.json({ id: result.lastInsertRowid });
});

router.delete("/books/:id", authMiddleware, (req: any, res) => {
  const bookId = req.params.id;
  
  const book = db.prepare("SELECT library_id FROM books WHERE id = ?").get(bookId) as any;
  if (!book) return res.status(404).json({ error: "Book not found" });

  const access = db.prepare("SELECT role FROM library_users WHERE library_id = ? AND user_id = ?").get(book.library_id, req.userId) as any;
  if (!access || access.role === 'viewer') return res.status(403).json({ error: "Access denied" });

  db.prepare("DELETE FROM books WHERE id = ?").run(bookId);
  res.json({ success: true });
});

export default router;
