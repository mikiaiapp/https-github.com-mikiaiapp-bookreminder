import { GoogleGenAI, Type } from "@google/genai";
import fs from "fs";
import path from "path";

export const analyzeBookBackend = async (
  content: string, 
  onProgress?: (progress: number, message: string, partialData?: any, lastChunk?: number) => void,
  initialState?: any,
  startChunk: number = 0
) => {
  console.log("[Gemini Backend] Initializing GoogleGenAI...");
  
  if (onProgress) onProgress(5, "Inicializando motor de IA...");
  
  let apiKey = process.env.GEMINI_API_KEY || "";
  
  // Try to read key from persistent file first (more secure for NAS/Docker)
  const keyFilePath = "/app/data/gemini_key.txt";
  try {
    if (fs.existsSync(keyFilePath)) {
      const fileKey = fs.readFileSync(keyFilePath, "utf8").trim();
      if (fileKey) {
        apiKey = fileKey;
        console.log("[Gemini Backend] API Key loaded from /app/data/gemini_key.txt");
      }
    }
  } catch (err) {
    console.log("[Gemini Backend] Could not read key file, falling back to env var");
  }

  if (!apiKey) {
    console.error("[Gemini Backend] CRITICAL ERROR: GEMINI_API_KEY is not set!");
    throw new Error("GEMINI_API_KEY is not set");
  }
  
  const ai = new GoogleGenAI({ apiKey });
  const model = "gemini-3-flash-preview";
  
  let metadata = initialState?.metadata || null;
  let allChapterSummaries = initialState?.resumen_capitulos || "";
  let allCharacterNotes = initialState?.notas_personajes || "";

  // 1. EXTRAER METADATOS (FICHA TÉCNICA) - Solo si no los tenemos
  if (!metadata) {
    console.log("[Gemini Backend] Phase 1: Extracting Book Metadata...");
    const metadataPrompt = `Extrae FICHA TÉCNICA: Título, Autor, ISBN, Sinopsis, Biografía autor, Bibliografía y Datos publicación.
    CONTENIDO: ${content.substring(0, 100000)}`;
    
    metadata = await runAnalysis(ai, model, metadataPrompt, "METADATOS", {
      titulo: { type: Type.STRING },
      autor: { type: Type.STRING },
      isbn: { type: Type.STRING },
      sinopsis: { type: Type.STRING },
      biografia_autor: { type: Type.STRING },
      bibliografia_autor: { type: Type.STRING },
      datos_publicacion: { type: Type.STRING },
    });

    if (onProgress) onProgress(15, "Ficha técnica extraída. Analizando capítulos...", metadata, 0);
  }

  // 2. ANÁLISIS POR BLOQUES (CAPÍTULOS Y PERSONAJES)
  const CHUNK_SIZE = 2000000; // Aumentado a 2M para reducir peticiones (Gemini 3 Flash tiene 1M+ tokens de contexto)
  const totalLength = content.length;
  const numChunks = Math.ceil(totalLength / CHUNK_SIZE);
  
  for (let i = startChunk; i < numChunks; i++) {
    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, totalLength);
    const chunk = content.substring(start, end);

    console.log(`[Gemini Backend] Phase 2: Analyzing chunk ${i + 1}/${numChunks}...`);
    
    // Reducir espera si es la primera petición de la sesión para agilizar
    if (i > startChunk) {
      console.log("[Gemini Backend] Waiting 30 seconds for quota reset...");
      await new Promise(resolve => setTimeout(resolve, 30000));
    }

    const chunkPrompt = `Fragmento ${i + 1} de ${numChunks} de "${metadata.titulo}".
    TAREA: 
    1. Resumen de capítulos: Identifica capítulos en este fragmento y resúmelos con detalle (modo spoiler).
    2. Notas de personajes: Identifica personajes nuevos o evolución de los existentes.
    
    IMPORTANTE: Sé conciso pero riguroso. Si un capítulo empieza en este bloque pero no termina, resume lo que hay.
    
    CONTENIDO: ${chunk}`;

    const chunkResult = await runAnalysis(ai, model, chunkPrompt, `BLOQUE ${i + 1}`, {
      resumen_capitulos: { type: Type.STRING },
      notas_personajes: { type: Type.STRING }
    });

    allChapterSummaries += "\n\n" + chunkResult.resumen_capitulos;
    allCharacterNotes += "\n\n" + chunkResult.notas_personajes;

    if (onProgress) {
      const chunkProgress = 15 + Math.floor(((i + 1) / numChunks) * 60);
      onProgress(chunkProgress, `Analizado bloque ${i + 1} de ${numChunks}...`, {
        metadata,
        resumen_capitulos: allChapterSummaries,
        notas_personajes: allCharacterNotes
      }, i + 1);
    }
  }

  // 3. SÍNTESIS FINAL
  console.log("[Gemini Backend] Phase 3: Synthesizing Final Analysis...");
  console.log("[Gemini Backend] Waiting 45 seconds for final quota reset...");
  await new Promise(resolve => setTimeout(resolve, 45000));

  const synthesisPrompt = `Sintetiza análisis final de "${metadata.titulo}".
  RESÚMENES: ${allChapterSummaries.substring(0, 50000)}
  NOTAS: ${allCharacterNotes.substring(0, 20000)}
  TAREAS: 1. Resumen general. 2. Análisis personajes/evolución. 3. Mapa Mermaid. 4. Guiones Podcast (Personajes y Libro).`;

  const synthesis = await runAnalysis(ai, model, synthesisPrompt, "SÍNTESIS FINAL", {
    resumen_general: { type: Type.STRING },
    analisis_personajes: { type: Type.STRING },
    evolucion_protagonista: { type: Type.STRING },
    mermaid_code: { type: Type.STRING },
    guion_podcast_personajes: { type: Type.STRING },
    guion_podcast_libro: { type: Type.STRING },
  });

  if (onProgress) onProgress(100, "Análisis completado con éxito.", {
    metadata,
    resumen_capitulos: allChapterSummaries,
    notas_personajes: allCharacterNotes,
    ...synthesis
  }, numChunks);

  // 4. ENSAMBLAJE FINAL
  return {
    ...metadata,
    resumen_detallado_capitulos: allChapterSummaries,
    resumen_capitulos: allChapterSummaries,
    ...synthesis
  };
};

export const identifyBook = async (content: string) => {
  const ai = getAI();
  const prompt = `Identifica TÍTULO y AUTOR del siguiente libro.
  CONTENIDO: ${content.substring(0, 50000)}`;
  
  return runAnalysis(ai, "gemini-3-flash-preview", prompt, "IDENTIFICACIÓN", {
    titulo: { type: Type.STRING },
    autor: { type: Type.STRING }
  });
};

export const fetchBookMetadata = async (titulo: string, autor: string) => {
  const ai = getAI();
  const prompt = `Busca información detallada del libro "${titulo}" de ${autor}.
  Necesito: ISBN (solo el número), Sinopsis (resumen de la trama), Biografía del autor, Bibliografía destacada y Datos de publicación (editorial, año).
  Usa herramientas de búsqueda para obtener datos reales.`;
  
  try {
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: [{ parts: [{ text: prompt }] }],
      config: {
        tools: [{ googleSearch: {} }],
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            isbn: { type: Type.STRING },
            sinopsis: { type: Type.STRING },
            biografia_autor: { type: Type.STRING },
            bibliografia_autor: { type: Type.STRING },
            datos_publicacion: { type: Type.STRING },
          },
          required: ["isbn", "sinopsis", "biografia_autor", "bibliografia_autor", "datos_publicacion"]
        }
      }
    });
    
    const text = response.text;
    if (!text) throw new Error("No se recibió respuesta de metadatos");
    return JSON.parse(text);
  } catch (err: any) {
    console.error("[Gemini] Error fetching metadata:", err);
    // Fallback to a simpler prompt without search if search fails
    const fallbackPrompt = `Proporciona información general del libro "${titulo}" de ${autor} en formato JSON.`;
    return runAnalysis(ai, "gemini-3-flash-preview", fallbackPrompt, "METADATOS FALLBACK", {
      isbn: { type: Type.STRING },
      sinopsis: { type: Type.STRING },
      biografia_autor: { type: Type.STRING },
      bibliografia_autor: { type: Type.STRING },
      datos_publicacion: { type: Type.STRING },
    });
  }
};

export const detectChapters = async (content: string) => {
  const ai = getAI();
  const prompt = `Identifica la lista de CAPÍTULOS o PARTES de este libro.
  Devuelve una lista de títulos o números de capítulos.
  CONTENIDO: ${content.substring(0, 100000)}`;
  
  const result = await runAnalysis(ai, "gemini-3-flash-preview", prompt, "DETECCIÓN CAPÍTULOS", {
    capitulos: { 
      type: Type.ARRAY,
      items: { type: Type.STRING }
    }
  });
  return result.capitulos;
};

export const analyzeChapters = async (content: string) => {
  const ai = getAI();
  const CHUNK_SIZE = 2000000;
  const totalLength = content.length;
  const numChunks = Math.ceil(totalLength / CHUNK_SIZE);
  let allSummaries = "";

  for (let i = 0; i < numChunks; i++) {
    const chunk = content.substring(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
    const prompt = `Resume detalladamente por capítulos el siguiente fragmento del libro.
    CONTENIDO: ${chunk}`;
    
    const result = await runAnalysis(ai, "gemini-3-flash-preview", prompt, `CAPÍTULOS ${i+1}`, {
      resumen: { type: Type.STRING }
    });
    allSummaries += (allSummaries ? "\n\n" : "") + result.resumen;
    
    if (i < numChunks - 1) await new Promise(r => setTimeout(r, 20000));
  }
  return allSummaries;
};

export const generateGeneralSummary = async (chapters: string) => {
  const ai = getAI();
  const prompt = `Basándote en los resúmenes de capítulos, genera un RESUMEN GENERAL riguroso del libro.
  CAPÍTULOS: ${chapters.substring(0, 50000)}`;
  
  const result = await runAnalysis(ai, "gemini-3-flash-preview", prompt, "RESUMEN GENERAL", {
    resumen: { type: Type.STRING }
  });
  return result.resumen;
};

export const analyzeCharactersPhased = async (chapters: string) => {
  const ai = getAI();
  const prompt = `Analiza los PERSONAJES y su EVOLUCIÓN basándote en los resúmenes de capítulos.
  CAPÍTULOS: ${chapters.substring(0, 50000)}`;
  
  return runAnalysis(ai, "gemini-3-flash-preview", prompt, "PERSONAJES", {
    personajes: { type: Type.STRING },
    evolucion: { type: Type.STRING }
  });
};

export const generateMentalMap = async (summary: string, characters: string) => {
  const ai = getAI();
  const prompt = `Crea un MAPA MENTAL en código MERMAID (graph TD) que conecte temas, personajes y trama.
  RESUMEN: ${summary.substring(0, 10000)}
  PERSONAJES: ${characters.substring(0, 10000)}`;
  
  const result = await runAnalysis(ai, "gemini-3-flash-preview", prompt, "MAPA MENTAL", {
    mermaid: { type: Type.STRING }
  });
  return result.mermaid;
};

export const generatePodcastScripts = async (summary: string, characters: string) => {
  const ai = getAI();
  const prompt = `Genera dos guiones de PODCAST:
  1. Un monólogo explicando el libro.
  2. Un diálogo entre dos personajes comentando la historia.
  RESUMEN: ${summary.substring(0, 10000)}
  PERSONAJES: ${characters.substring(0, 10000)}`;
  
  return runAnalysis(ai, "gemini-3-flash-preview", prompt, "PODCAST", {
    libro: { type: Type.STRING },
    personajes: { type: Type.STRING }
  });
};

export const generateExtraInfo = async (summary: string) => {
  const ai = getAI();
  const prompt = `Genera información extra para el recuerdo emocional del libro:
  1. Sentimiento clave: ¿Qué sensación deja el libro al terminarlo?
  2. Citas clave: 3 frases memorables que capturen la esencia.
  RESUMEN: ${summary.substring(0, 10000)}`;
  
  return runAnalysis(ai, "gemini-3-flash-preview", prompt, "EXTRA", {
    sentimiento: { type: Type.STRING },
    citas: { type: Type.STRING }
  });
};

function getAI() {
  let apiKey = process.env.GEMINI_API_KEY || "";
  const keyFilePath = "/app/data/gemini_key.txt";
  try {
    if (fs.existsSync(keyFilePath)) {
      apiKey = fs.readFileSync(keyFilePath, "utf8").trim();
    }
  } catch (err) {}
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
  return new GoogleGenAI({ apiKey });
}

async function runAnalysis(ai: any, model: string, promptText: string, phaseName: string, schemaProperties: any) {
  const prompt = `
Actúas como el motor lógico de "Mi Biblioteca Personal NAS". Responde exclusivamente en JSON.

${promptText}

### RESTRICCIONES:
- Idioma: Español de España.
- Salida: JSON puro.
`;

  const MAX_RETRIES = 3;
  let lastError: any = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents: [{ parts: [{ text: prompt }] }],
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: schemaProperties,
            required: Object.keys(schemaProperties)
          }
        }
      });

      const resultText = response.text;
      if (!resultText) throw new Error(`No response from Gemini in ${phaseName}`);
      return JSON.parse(resultText);
    } catch (error: any) {
      lastError = error;
      // 503: Service Unavailable (High demand)
      // 429: Quota Exceeded
      const isRetryable = error.status === 503 || error.status === 429 || 
                          (error.message && (error.message.includes("503") || error.message.includes("429")));
      
      if (isRetryable && attempt < MAX_RETRIES) {
        const delay = attempt * 30000; // 30s, 60s...
        console.warn(`[Gemini Backend] Attempt ${attempt} failed for ${phaseName} (Status: ${error.status}). Retrying in ${delay/1000}s...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      
      if (error.status === 429 && error.message.includes("Quota exceeded")) {
        throw new Error("Cuota diaria de Gemini agotada (Límite: 20 peticiones/día). Por favor, espera 24h o usa otra API Key.");
      }
      
      console.error(`[Gemini Backend] Error in ${phaseName} after ${attempt} attempts:`, error);
      throw error;
    }
  }
  throw lastError;
}
