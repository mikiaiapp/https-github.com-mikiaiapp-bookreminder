import { GoogleGenAI, Type } from "@google/genai";
import fs from "fs";
import path from "path";

export const analyzeBookBackend = async (content: string, onProgress?: (progress: number) => void) => {
  console.log("[Gemini Backend] Initializing GoogleGenAI...");
  
  if (onProgress) onProgress(5);
  
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
  
  // 1. EXTRAER METADATOS (FICHA TÉCNICA)
  console.log("[Gemini Backend] Phase 1: Extracting Book Metadata...");
  const metadataPrompt = `Analiza el inicio de este libro y extrae la FICHA TÉCNICA COMPLETA. 
  Incluye: Título, Autor, ISBN, Sinopsis, Biografía detallada del autor, Bibliografía destacada y datos de publicación.
  CONTENIDO INICIAL: ${content.substring(0, 100000)}`;
  
  const metadata = await runAnalysis(ai, model, metadataPrompt, "METADATOS", {
    titulo: { type: Type.STRING },
    autor: { type: Type.STRING },
    isbn: { type: Type.STRING },
    sinopsis: { type: Type.STRING },
    biografia_autor: { type: Type.STRING },
    bibliografia_autor: { type: Type.STRING },
    datos_publicacion: { type: Type.STRING },
  });

  if (onProgress) onProgress(15);

  // 2. ANÁLISIS POR BLOQUES (CAPÍTULOS Y PERSONAJES)
  const CHUNK_SIZE = 350000; // Bloques más pequeños para evitar saturación
  const totalLength = content.length;
  const numChunks = Math.ceil(totalLength / CHUNK_SIZE);
  
  let allChapterSummaries = "";
  let allCharacterNotes = "";

  for (let i = 0; i < numChunks; i++) {
    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, totalLength);
    const chunk = content.substring(start, end);

    console.log(`[Gemini Backend] Phase 2: Analyzing chunk ${i + 1}/${numChunks}...`);
    
    if (i > 0) {
      console.log("[Gemini Backend] Waiting 45 seconds for quota reset...");
      await new Promise(resolve => setTimeout(resolve, 45000));
    }

    const chunkPrompt = `Estás analizando el fragmento ${i + 1} del libro "${metadata.titulo}".
    Tu tarea es:
    1. Hacer un resumen exhaustivo capítulo a capítulo de este fragmento.
    2. Identificar personajes que aparecen y notas sobre su psicología/evolución en esta parte.
    
    CONTENIDO DEL FRAGMENTO:
    ${chunk}`;

    const chunkResult = await runAnalysis(ai, model, chunkPrompt, `BLOQUE ${i + 1}`, {
      resumen_capitulos: { type: Type.STRING, description: "Resumen detallado de los capítulos en este bloque" },
      notas_personajes: { type: Type.STRING, description: "Notas sobre personajes y evolución en este bloque" }
    });

    allChapterSummaries += "\n\n" + chunkResult.resumen_capitulos;
    allCharacterNotes += "\n\n" + chunkResult.notas_personajes;

    if (onProgress) {
      const chunkProgress = 15 + Math.floor(((i + 1) / numChunks) * 60);
      onProgress(chunkProgress);
    }
  }

  // 3. SÍNTESIS FINAL
  console.log("[Gemini Backend] Phase 3: Synthesizing Final Analysis...");
  console.log("[Gemini Backend] Waiting 45 seconds for final quota reset...");
  await new Promise(resolve => setTimeout(resolve, 45000));

  const synthesisPrompt = `Basándote en los siguientes resúmenes de capítulos y notas de personajes, genera el análisis final del libro "${metadata.titulo}".
  
  RESÚMENES DE CAPÍTULOS ACUMULADOS:
  ${allChapterSummaries}
  
  NOTAS DE PERSONAJES ACUMULADAS:
  ${allCharacterNotes}
  
  TAREAS FINALES:
  1. Crea un RESUMEN GENERAL que sintetice toda la obra.
  2. Consolida el ANÁLISIS DE PERSONAJES y su EVOLUCIÓN final.
  3. Genera el MAPA MERMAID de la obra completa.
  4. Redacta los dos GUIONES DE PODCAST (Personajes y Resumen).`;

  const synthesis = await runAnalysis(ai, model, synthesisPrompt, "SÍNTESIS FINAL", {
    resumen_general: { type: Type.STRING },
    analisis_personajes: { type: Type.STRING },
    evolucion_protagonista: { type: Type.STRING },
    mermaid_code: { type: Type.STRING },
    guion_podcast_personajes: { type: Type.STRING },
    guion_podcast_libro: { type: Type.STRING },
  });

  if (onProgress) onProgress(100);

  // 4. ENSAMBLAJE FINAL
  return {
    ...metadata,
    resumen_detallado_capitulos: allChapterSummaries,
    resumen_capitulos: allChapterSummaries,
    ...synthesis
  };
};

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
      
      console.error(`[Gemini Backend] Error in ${phaseName} after ${attempt} attempts:`, error);
      throw error;
    }
  }
  throw lastError;
}
