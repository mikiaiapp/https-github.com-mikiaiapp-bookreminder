import { Router } from "express";
import bcrypt from "bcryptjs";
import { generateSecret, verify, generateURI } from "otplib";
import qrcode from "qrcode";
import crypto from "crypto";
import db from "./db";
import { authMiddleware, generateToken } from "./auth";
import { sendEmail } from "./mailer";
import { 
  analyzeBookBackend, 
  identifyBook, 
  fetchBookMetadata, 
  detectChapters,
  summarizeSpecificChapter,
  analyzeChapters, 
  generateGeneralSummary, 
  analyzeCharactersPhased, 
  generateMentalMap, 
  generatePodcastScripts,
  generateExtraInfo
} from "./gemini";

const router = Router();

// --- GEMINI ANALYSIS ---
router.post("/analyze", authMiddleware, async (req: any, res) => {
  console.log("[API /analyze] Request received");
  try {
    const { content, libraryId, bookId: existingBookId } = req.body;
    if (!content || !libraryId) {
      return res.status(400).json({ error: "Content and libraryId are required" });
    }
    
    const jobId = crypto.randomUUID();
    let bookId = existingBookId;
    
    if (!bookId) {
      // Create a placeholder book first
      const bookResult = db.prepare(`
        INSERT INTO books (library_id, titulo, status)
        VALUES (?, ?, 'processing')
      `).run(libraryId, 'Analizando nuevo libro...');
      bookId = bookResult.lastInsertRowid;
    } else {
      // Update existing book to processing
      db.prepare("UPDATE books SET status = 'processing' WHERE id = ?").run(bookId);
    }

    db.prepare("INSERT INTO analysis_jobs (id, status, progress, content, book_id) VALUES (?, ?, ?, ?, ?)")
      .run(jobId, 'processing', 0, content, bookId);
    
    // Start analysis in background
    (async () => {
      try {
        let accumulatedLogs = "";
        
        // Check if we can resume
        const existingJob = db.prepare("SELECT * FROM analysis_jobs WHERE id = ?").get(jobId) as any;
        const initialState = existingJob?.partial_result ? JSON.parse(existingJob.partial_result) : null;
        const startChunk = existingJob?.last_chunk || 0;

        const analysis = await analyzeBookBackend(content, (progress, message, partialData, lastChunk) => {
          accumulatedLogs += (accumulatedLogs ? "\n" : "") + message;
          db.prepare("UPDATE analysis_jobs SET progress = ?, message = ?, logs = ?, partial_result = ?, last_chunk = ? WHERE id = ?")
            .run(progress, message, accumulatedLogs, partialData ? JSON.stringify(partialData) : null, lastChunk, jobId);
          
          // Also update the book if we have metadata
          if (partialData && partialData.metadata) {
            const m = partialData.metadata;
            db.prepare(`
              UPDATE books SET 
                titulo = ?, autor = ?, isbn = ?, sinopsis = ?, 
                biografia_autor = ?, bibliografia_autor = ?, datos_publicacion = ?,
                resumen_capitulos = ?, resumen_detallado_capitulos = ?, analisis_personajes = ?, status = 'partial'
              WHERE id = (SELECT book_id FROM analysis_jobs WHERE id = ?)
            `).run(
              m.titulo, m.autor, m.isbn, m.sinopsis, 
              m.biografia_autor, m.bibliografia_autor, m.datos_publicacion,
              partialData.resumen_capitulos || "", 
              partialData.resumen_capitulos || "", // Use same for detailed during partial
              partialData.notas_personajes || "",
              jobId
            );
          }
        }, initialState, startChunk);

        db.prepare("UPDATE analysis_jobs SET status = ?, progress = 100, message = ?, logs = ?, result = ? WHERE id = ?")
          .run('completed', 'Finalizado', accumulatedLogs + "\nFinalizado", JSON.stringify(analysis), jobId);
        
        // Final book update
        db.prepare(`
          UPDATE books SET 
            titulo = ?, autor = ?, isbn = ?, sinopsis = ?, 
            biografia_autor = ?, bibliografia_autor = ?, datos_publicacion = ?,
            resumen_general = ?, resumen_detallado_capitulos = ?, resumen_capitulos = ?,
            analisis_personajes = ?, evolucion_protagonista = ?, mermaid_code = ?,
            guion_podcast_personajes = ?, guion_podcast_libro = ?, status = 'completed'
          WHERE id = (SELECT book_id FROM analysis_jobs WHERE id = ?)
        `).run(
          analysis.titulo, analysis.autor, analysis.isbn, analysis.sinopsis,
          analysis.biografia_autor, analysis.bibliografia_autor, analysis.datos_publicacion,
          analysis.resumen_general, analysis.resumen_detallado_capitulos, analysis.resumen_capitulos,
          analysis.analisis_personajes, analysis.evolucion_protagonista, analysis.mermaid_code,
          analysis.guion_podcast_personajes, analysis.guion_podcast_libro,
          jobId
        );
      } catch (err: any) {
        console.error(`[Job ${jobId}] Error:`, err);
        db.prepare("UPDATE analysis_jobs SET status = ?, error = ? WHERE id = ?").run('failed', err.message, jobId);
        
        // Mark book as partial/failed
        db.prepare("UPDATE books SET status = 'partial' WHERE id = (SELECT book_id FROM analysis_jobs WHERE id = ?)")
          .run(jobId);
      }
    })();

    res.json({ jobId, bookId });
  } catch (err: any) {
    console.error("[API /analyze] Error starting job:", err);
    res.status(500).json({ error: "Error starting analysis" });
  }
});

router.get("/analysis-status/:jobId", authMiddleware, (req, res) => {
  const job = db.prepare("SELECT * FROM analysis_jobs WHERE id = ?").get(req.params.jobId) as any;
  if (!job) return res.status(404).json({ error: "Job not found" });
  
  const response: any = { 
    status: job.status, 
    progress: job.progress, 
    message: job.message,
    logs: job.logs ? job.logs.split("\n") : [],
    partialResult: job.partial_result ? JSON.parse(job.partial_result) : null
  };

  if (job.status === 'completed') {
    response.result = JSON.parse(job.result);
  } else if (job.status === 'failed') {
    response.error = job.error;
  }
  
  res.json(response);
});

router.get("/books/:id/job", authMiddleware, (req: any, res) => {
  const bookId = req.params.id;
  const job = db.prepare("SELECT id, content FROM analysis_jobs WHERE book_id = ?").get(bookId) as any;
  if (!job) return res.status(404).json({ error: "Job not found for this book" });
  res.json({ jobId: job.id, content: job.content });
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
    evolucion_protagonista, mermaid_code, guion_podcast_personajes, guion_podcast_libro,
    content
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
    libraryId, titulo || 'Nuevo Libro', autor || '', isbn || '', sinopsis || '', biografia_autor || '', bibliografia_autor || '',
    datos_publicacion || '', resumen_general || '', resumen_detallado_capitulos || '',
    resumen_capitulos || '', analisis_personajes || '', 
    evolucion_protagonista || '', mermaid_code || '', guion_podcast_personajes || '', guion_podcast_libro || ''
  );

  const bookId = result.lastInsertRowid;

  // Si se proporciona contenido, crear un trabajo de análisis para guardarlo
  if (content) {
    const jobId = Math.random().toString(36).substring(7);
    db.prepare("INSERT INTO analysis_jobs (id, status, progress, content, book_id) VALUES (?, ?, ?, ?, ?)")
      .run(jobId, 'pending', 0, content, bookId);
  }

  res.json({ id: bookId });
});

router.delete("/books/:id", authMiddleware, (req: any, res) => {
  const bookId = req.params.id;
  
  try {
    const book = db.prepare("SELECT library_id FROM books WHERE id = ?").get(bookId) as any;
    if (!book) return res.status(404).json({ error: "Book not found" });

    const access = db.prepare("SELECT role FROM library_users WHERE library_id = ? AND user_id = ?").get(book.library_id, req.userId) as any;
    if (!access || access.role === 'viewer') return res.status(403).json({ error: "Access denied" });

    // Delete related records first to avoid foreign key constraints
    db.prepare("DELETE FROM analysis_jobs WHERE book_id = ?").run(bookId);
    db.prepare("DELETE FROM chapters WHERE book_id = ?").run(bookId);
    db.prepare("DELETE FROM books WHERE id = ?").run(bookId);
    
    res.json({ success: true });
  } catch (err: any) {
    console.error('Error deleting book:', err);
    res.status(500).json({ error: "Error interno al eliminar el libro" });
  }
});

// --- PHASED ANALYSIS ROUTES ---

router.post("/books/:id/identify", authMiddleware, async (req: any, res) => {
  const { content } = req.body;
  const bookId = req.params.id;
  
  console.log(`[API /identify] Request for book ${bookId}. Content length: ${content?.length || 0}`);

  if (!content || content.trim().length === 0) {
    return res.status(400).json({ error: "El contenido del libro está vacío o no se ha recibido correctamente." });
  }
  try {
    const info = await identifyBook(content);
    db.prepare("UPDATE books SET titulo = ?, autor = ?, phase = 0 WHERE id = ?").run(info.titulo, info.autor, bookId);
    res.json(info);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/books/:id/metadata", authMiddleware, async (req: any, res) => {
  const bookId = req.params.id;
  const book = db.prepare("SELECT titulo, autor FROM books WHERE id = ?").get(bookId) as any;
  if (!book) return res.status(404).json({ error: "Libro no encontrado" });
  try {
    const metadata = await fetchBookMetadata(book.titulo, book.autor);
    db.prepare(`
      UPDATE books SET 
        isbn = ?, sinopsis = ?, biografia_autor = ?, 
        bibliografia_autor = ?, datos_publicacion = ?, phase = 1
      WHERE id = ?
    `).run(
      metadata.isbn || "", metadata.sinopsis || "", metadata.biografia_autor || "", 
      metadata.bibliografia_autor || "", metadata.datos_publicacion || "", bookId
    );
    res.json(metadata);
  } catch (err: any) {
    console.error("[API /metadata] Error:", err);
    res.status(500).json({ error: err.message });
  }
});

router.post("/books/:id/detect-chapters", authMiddleware, async (req: any, res) => {
  const { content } = req.body;
  const bookId = req.params.id;
  try {
    const chapterTitles = await detectChapters(content);
    
    // Limpiar capítulos previos si existen
    db.prepare("DELETE FROM chapters WHERE book_id = ?").run(bookId);
    
    // Insertar nuevos capítulos
    const insert = db.prepare("INSERT INTO chapters (book_id, title, order_index) VALUES (?, ?, ?)");
    chapterTitles.forEach((title: string, index: number) => {
      insert.run(bookId, title, index);
    });

    db.prepare("UPDATE books SET resumen_capitulos = ?, phase = 2 WHERE id = ?")
      .run(JSON.stringify(chapterTitles), bookId);
    
    res.json({ chapters: chapterTitles });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/books/:id/chapters", authMiddleware, (req: any, res) => {
  const bookId = req.params.id;
  const chapters = db.prepare("SELECT * FROM chapters WHERE book_id = ? ORDER BY order_index ASC").all(bookId);
  res.json(chapters);
});

router.post("/books/:id/chapters/:chapterId/summarize", authMiddleware, async (req: any, res) => {
  const bookId = req.params.id;
  const chapterId = req.params.chapterId;
  const { content } = req.body;
  
  try {
    const chapter = db.prepare("SELECT * FROM chapters WHERE id = ?").get(chapterId) as any;
    if (!chapter) return res.status(404).json({ error: "Capítulo no encontrado" });

    console.log(`[API /summarize] Summarizing chapter: ${chapter.title} (ID: ${chapterId}) for book: ${bookId}`);
    const result = await summarizeSpecificChapter(content, chapter.title);
    
    db.prepare("UPDATE chapters SET summary = ?, character_notes = ? WHERE id = ?")
      .run(result.resumen, result.notas_personajes, chapterId);
    
    // También actualizar el resumen detallado global del libro (concatenando)
    const allChapters = db.prepare("SELECT summary, character_notes FROM chapters WHERE book_id = ? AND summary IS NOT NULL ORDER BY order_index ASC").all(bookId) as any[];
    const fullSummary = allChapters.map(c => c.summary).join("\n\n");
    const allCharacterNotes = allChapters.map(c => c.character_notes).filter(n => n).join("\n\n");
    
    db.prepare("UPDATE books SET resumen_detallado_capitulos = ?, evolucion_protagonista = ? WHERE id = ?")
      .run(fullSummary, allCharacterNotes, bookId);

    res.json(result);
  } catch (err: any) {
    console.error(`[API /summarize] Error:`, err);
    res.status(500).json({ error: err.message });
  }
});

router.post("/books/:id/summary", authMiddleware, async (req: any, res) => {
  const bookId = req.params.id;
  try {
    const book = db.prepare("SELECT * FROM books WHERE id = ?").get(bookId) as any;
    if (!book) return res.status(404).json({ error: "Libro no encontrado" });
    
    // Usar los resúmenes de capítulos si existen en la tabla chapters
    const chapters = db.prepare("SELECT summary FROM chapters WHERE book_id = ? AND summary IS NOT NULL ORDER BY order_index ASC").all(bookId) as any[];
    const chaptersText = chapters.length > 0 
      ? chapters.map(c => c.summary).join("\n\n")
      : book.resumen_detallado_capitulos || "";

    const summary = await generateGeneralSummary(chaptersText);
    db.prepare("UPDATE books SET resumen_general = ?, phase = 4 WHERE id = ?")
      .run(summary, bookId);
    res.json({ summary });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/books/:id/characters", authMiddleware, async (req: any, res) => {
  const bookId = req.params.id;
  try {
    const book = db.prepare("SELECT * FROM books WHERE id = ?").get(bookId) as any;
    if (!book) return res.status(404).json({ error: "Libro no encontrado" });
    
    // Combinar resúmenes de capítulos y notas de personajes
    const chapters = db.prepare("SELECT summary, character_notes FROM chapters WHERE book_id = ? ORDER BY order_index ASC").all(bookId) as any[];
    const context = chapters.map(c => `RESUMEN: ${c.summary || ""}\nNOTAS PERSONAJES: ${c.character_notes || ""}`).join("\n\n");

    const analysis = await analyzeCharactersPhased(context || book.resumen_detallado_capitulos || "");
    db.prepare("UPDATE books SET analisis_personajes = ?, evolucion_protagonista = ?, phase = 3 WHERE id = ?")
      .run(analysis.personajes, analysis.evolucion, bookId);
    res.json(analysis);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/books/:id/map", authMiddleware, async (req: any, res) => {
  const bookId = req.params.id;
  const book = db.prepare("SELECT resumen_general, analisis_personajes FROM books WHERE id = ?").get(bookId) as any;
  try {
    const mermaid = await generateMentalMap(book.resumen_general, book.analisis_personajes);
    db.prepare("UPDATE books SET mermaid_code = ?, phase = 5 WHERE id = ?")
      .run(mermaid, bookId);
    res.json({ mermaid });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/books/:id/podcast", authMiddleware, async (req: any, res) => {
  const bookId = req.params.id;
  const book = db.prepare("SELECT resumen_general, analisis_personajes FROM books WHERE id = ?").get(bookId) as any;
  try {
    const scripts = await generatePodcastScripts(book.resumen_general, book.analisis_personajes);
    db.prepare("UPDATE books SET guion_podcast_personajes = ?, guion_podcast_libro = ?, phase = 6 WHERE id = ?")
      .run(scripts.personajes, scripts.libro, bookId);
    res.json(scripts);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/books/:id/extra", authMiddleware, async (req: any, res) => {
  const bookId = req.params.id;
  const book = db.prepare("SELECT resumen_general FROM books WHERE id = ?").get(bookId) as any;
  try {
    const extra = await generateExtraInfo(book.resumen_general);
    db.prepare("UPDATE books SET sentimiento_clave = ?, citas_clave = ?, phase = 7 WHERE id = ?")
      .run(extra.sentimiento, extra.citas, bookId);
    res.json(extra);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
