import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

const dbPath = process.env.DB_PATH || "library.db";
const dbDir = path.dirname(dbPath);

if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(dbPath);

// Migrations / Schema
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    totp_secret TEXT,
    is_totp_enabled BOOLEAN DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS libraries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    owner_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (owner_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS library_users (
    library_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    role TEXT NOT NULL,
    PRIMARY KEY (library_id, user_id),
    FOREIGN KEY (library_id) REFERENCES libraries(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS books (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    library_id INTEGER,
    titulo TEXT,
    autor TEXT,
    isbn TEXT,
    sinopsis TEXT,
    biografia_autor TEXT,
    bibliografia_autor TEXT,
    datos_publicacion TEXT,
    resumen_general TEXT,
    resumen_detallado_capitulos TEXT,
    resumen_capitulos TEXT,
    analisis_personajes TEXT,
    evolucion_protagonista TEXT,
    mermaid_code TEXT,
    guion_podcast_personajes TEXT,
    guion_podcast_libro TEXT,
    sentimiento_clave TEXT,
    citas_clave TEXT,
    phase INTEGER DEFAULT 0, -- 0: Identificado, 1: Ficha, 2: Capítulos, 3: Resumen, 4: Personajes, 5: Mapa, 6: Podcast
    status TEXT DEFAULT 'completed', -- 'completed', 'partial', 'processing'
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (library_id) REFERENCES libraries(id)
  );

  CREATE TABLE IF NOT EXISTS password_resets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token TEXT NOT NULL,
    expires_at DATETIME NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS library_invitations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    library_id INTEGER NOT NULL,
    email TEXT NOT NULL,
    token TEXT NOT NULL,
    role TEXT NOT NULL,
    expires_at DATETIME NOT NULL,
    FOREIGN KEY (library_id) REFERENCES libraries(id)
  );

  CREATE TABLE IF NOT EXISTS analysis_jobs (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL, -- 'pending', 'processing', 'completed', 'failed'
    progress INTEGER DEFAULT 0,
    message TEXT,
    logs TEXT, -- Accumulated messages
    partial_result TEXT, -- Incremental data
    content TEXT, -- Store content to allow resuming
    last_chunk INTEGER DEFAULT 0,
    book_id INTEGER,
    result TEXT,
    error TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (book_id) REFERENCES books(id)
  );

  CREATE TABLE IF NOT EXISTS chapters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id INTEGER NOT NULL,
    part_name TEXT,
    title TEXT NOT NULL,
    summary TEXT,
    character_notes TEXT,
    order_index INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (book_id) REFERENCES books(id)
  );
`);

// Add part_name to chapters if it doesn't exist
try {
  db.prepare("SELECT part_name FROM chapters LIMIT 1").get();
} catch (e) {
  db.exec("ALTER TABLE chapters ADD COLUMN part_name TEXT");
}

// Add library_id to books if it doesn't exist (migration for existing data)
try {
  db.prepare("SELECT library_id FROM books LIMIT 1").get();
} catch (e) {
  db.exec("ALTER TABLE books ADD COLUMN library_id INTEGER REFERENCES libraries(id)");
}

// Migrations for new book fields
const newColumns = [
  'isbn', 'sinopsis', 'biografia_autor', 'bibliografia_autor', 
  'datos_publicacion', 'resumen_general', 'resumen_detallado_capitulos',
  'sentimiento_clave', 'citas_clave', 'phase'
];

for (const col of newColumns) {
  try {
    db.prepare(`SELECT ${col} FROM books LIMIT 1`).get();
  } catch (e) {
    if (col === 'phase') {
      db.exec(`ALTER TABLE books ADD COLUMN ${col} INTEGER DEFAULT 0`);
    } else {
      db.exec(`ALTER TABLE books ADD COLUMN ${col} TEXT`);
    }
  }
}

// Migration for analysis_jobs message column
try {
  db.prepare("SELECT message FROM analysis_jobs LIMIT 1").get();
} catch (e) {
  db.exec("ALTER TABLE analysis_jobs ADD COLUMN message TEXT");
}

try {
  db.prepare("SELECT logs FROM analysis_jobs LIMIT 1").get();
} catch (e) {
  db.exec("ALTER TABLE analysis_jobs ADD COLUMN logs TEXT");
}

try {
  db.prepare("SELECT partial_result FROM analysis_jobs LIMIT 1").get();
} catch (e) {
  db.exec("ALTER TABLE analysis_jobs ADD COLUMN partial_result TEXT");
}

try {
  db.prepare("SELECT status FROM books LIMIT 1").get();
} catch (e) {
  db.exec("ALTER TABLE books ADD COLUMN status TEXT DEFAULT 'completed'");
}

try {
  db.prepare("SELECT content FROM analysis_jobs LIMIT 1").get();
} catch (e) {
  db.exec("ALTER TABLE analysis_jobs ADD COLUMN content TEXT");
}

try {
  db.prepare("SELECT last_chunk FROM analysis_jobs LIMIT 1").get();
} catch (e) {
  db.exec("ALTER TABLE analysis_jobs ADD COLUMN last_chunk INTEGER DEFAULT 0");
}

try {
  db.prepare("SELECT book_id FROM analysis_jobs LIMIT 1").get();
} catch (e) {
  db.exec("ALTER TABLE analysis_jobs ADD COLUMN book_id INTEGER REFERENCES books(id)");
}

export default db;
