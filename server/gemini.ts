import { GoogleGenAI, Type } from "@google/genai";
import fs from "fs";
import path from "path";

export const analyzeBookBackend = async (content: string) => {
  console.log("[Gemini Backend] Initializing GoogleGenAI...");
  
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
  const CHUNK_SIZE = 400000; // ~100k tokens, safe for 250k TPM limit
  
  const totalLength = content.length;
  const numChunks = Math.ceil(totalLength / CHUNK_SIZE);
  
  console.log(`[Gemini Backend] Content size (${totalLength}) requires ${numChunks} chunks.`);

  let finalAnalysis: any = null;
  let accumulatedSummary = "";
  let accumulatedDetailedSummary = "";

  for (let i = 0; i < numChunks; i++) {
    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, totalLength);
    const chunk = content.substring(start, end);
    const isLast = i === numChunks - 1;

    console.log(`[Gemini Backend] Processing chunk ${i + 1}/${numChunks} (${chunk.length} chars)...`);

    if (i > 0) {
      console.log("[Gemini Backend] Waiting 35 seconds for quota reset...");
      await new Promise(resolve => setTimeout(resolve, 35000));
    }

    const prompt = i === 0 
      ? `Analiza la PRIMERA PARTE de este libro. Extrae la ficha técnica y empieza el resumen detallado.
         CONTENIDO: ${chunk}`
      : `Estás analizando la PARTE ${i + 1} de un libro. 
         RESUMEN ANTERIOR: ${accumulatedSummary}
         CONTENIDO ACTUAL: ${chunk}
         ${isLast ? "Esta es la PARTE FINAL. Cierra todas las tramas, evoluciones de personajes y genera los guiones de podcast definitivos." : "Continúa el resumen detallado de los capítulos."}`;

    const currentAnalysis = await runAnalysis(ai, model, prompt, `PARTE ${i + 1}`);

    if (i === 0) {
      finalAnalysis = currentAnalysis;
      accumulatedSummary = currentAnalysis.resumen_general;
      accumulatedDetailedSummary = currentAnalysis.resumen_detallado_capitulos;
    } else {
      accumulatedSummary = currentAnalysis.resumen_general;
      accumulatedDetailedSummary += "\n\n" + currentAnalysis.resumen_detallado_capitulos;
      
      // Update final object with latest data from current chunk
      finalAnalysis = {
        ...finalAnalysis,
        resumen_general: currentAnalysis.resumen_general,
        resumen_detallado_capitulos: accumulatedDetailedSummary,
        analisis_personajes: currentAnalysis.analisis_personajes,
        evolucion_protagonista: currentAnalysis.evolucion_protagonista,
        mermaid_code: currentAnalysis.mermaid_code,
        guion_podcast_personajes: currentAnalysis.guion_podcast_personajes,
        guion_podcast_libro: currentAnalysis.guion_podcast_libro
      };
    }
  }

  return finalAnalysis;
};

async function runAnalysis(ai: any, model: string, text: string, phaseName: string) {
  const prompt = `
Actúas como el motor lógico de "Mi Biblioteca Personal NAS". Tu misión es analizar el contenido proporcionado y devolver un JSON estructurado.

${text}

### REGLAS:
1. FICHA TÉCNICA: Título, autor, ISBN, sinopsis, biografía, bibliografía, datos publicación.
2. RESUMEN GENERAL: Esencia completa de la obra (si es la parte final, incluye el desenlace).
3. RESUMEN DETALLADO: Desglose capítulo a capítulo con spoilers y detalles minuciosos.
4. PERSONAJES: Psicología y evolución.
5. MAPA MERMAID: Código funcional.
6. PODCASTS: Dos guiones dinámicos.

### RESTRICCIONES:
- Idioma: Español de España.
- Salida: JSON puro.
- Estructura: { "titulo": "", "autor": "", "isbn": "", "sinopsis": "", "biografia_autor": "", "bibliografia_autor": "", "datos_publicacion": "", "resumen_general": "", "resumen_detallado_capitulos": "", "resumen_capitulos": "", "analisis_personajes": "", "evolucion_protagonista": "", "mermaid_code": "", "guion_podcast_personajes": "", "guion_podcast_libro": "" }
`;

  try {
    const response = await ai.models.generateContent({
      model,
      contents: [{ parts: [{ text: prompt }] }],
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            titulo: { type: Type.STRING },
            autor: { type: Type.STRING },
            isbn: { type: Type.STRING },
            sinopsis: { type: Type.STRING },
            biografia_autor: { type: Type.STRING },
            bibliografia_autor: { type: Type.STRING },
            datos_publicacion: { type: Type.STRING },
            resumen_general: { type: Type.STRING },
            resumen_detallado_capitulos: { type: Type.STRING },
            resumen_capitulos: { type: Type.STRING },
            analisis_personajes: { type: Type.STRING },
            evolucion_protagonista: { type: Type.STRING },
            mermaid_code: { type: Type.STRING },
            guion_podcast_personajes: { type: Type.STRING },
            guion_podcast_libro: { type: Type.STRING },
          },
          required: [
            "titulo", "autor", "isbn", "sinopsis", "biografia_autor", "bibliografia_autor",
            "datos_publicacion", "resumen_general", "resumen_detallado_capitulos", "resumen_capitulos",
            "analisis_personajes", "evolucion_protagonista", "mermaid_code", 
            "guion_podcast_personajes", "guion_podcast_libro"
          ]
        }
      }
    });

    const resultText = response.text;
    if (!resultText) throw new Error(`No response from Gemini in ${phaseName}`);
    return JSON.parse(resultText);
  } catch (error: any) {
    console.error(`[Gemini Backend] Error in ${phaseName}:`, error);
    throw error;
  }
}
