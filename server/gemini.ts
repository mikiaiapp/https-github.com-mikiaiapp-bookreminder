import { GoogleGenAI, Type } from "@google/genai";

export const analyzeBookBackend = async (content: string) => {
  console.log("[Gemini Backend] Initializing GoogleGenAI...");
  const apiKey = process.env.GEMINI_API_KEY || "";
  if (!apiKey) {
    console.error("[Gemini Backend] CRITICAL ERROR: GEMINI_API_KEY is not set or is empty!");
    throw new Error("GEMINI_API_KEY is not set");
  }
  
  const ai = new GoogleGenAI({ apiKey });
  const model = "gemini-3-flash-preview";
  const CHUNK_SIZE = 800000; // ~200k tokens, safe for 250k TPM limit

  if (content.length <= CHUNK_SIZE) {
    console.log(`[Gemini Backend] Content size (${content.length}) is within limits. Single pass analysis.`);
    return await runAnalysis(ai, model, content);
  }

  console.log(`[Gemini Backend] Content size (${content.length}) exceeds limits. Starting multi-part analysis...`);
  
  // PHASE 1: Analyze first part to get metadata and initial summary
  const part1 = content.substring(0, CHUNK_SIZE);
  console.log("[Gemini Backend] Phase 1: Analyzing first 800k characters...");
  const analysis1 = await runAnalysis(ai, model, part1, "PRIMERA PARTE");

  // PHASE 2: Analyze second part with context from part 1
  const part2 = content.substring(CHUNK_SIZE);
  console.log(`[Gemini Backend] Phase 2: Analyzing remaining ${part2.length} characters...`);
  
  // We wait a bit to let the TPM quota reset slightly (optional but safer)
  // await new Promise(resolve => setTimeout(resolve, 2000));

  const prompt2 = `
Actúas como el motor lógico de "Mi Biblioteca Personal NAS". Estás analizando la SEGUNDA PARTE de un libro.
Ya has analizado la primera parte y este es el resumen de lo ocurrido hasta ahora:
${analysis1.resumen_general}

### CONTENIDO DE LA SEGUNDA PARTE (FINAL DEL LIBRO):
${part2.substring(0, CHUNK_SIZE)}

### TU MISIÓN EN ESTA FASE:
1. Completa el "RESUMEN DETALLADO POR CAPÍTULOS" desde donde se quedó la primera parte hasta el FINAL ABSOLUTO.
2. Genera el "RESUMEN GENERAL" definitivo que cubra TODA la obra (inicio, nudo y desenlace).
3. Actualiza la "EVOLUCIÓN DEL PROTAGONISTA" y "ANÁLISIS DE PERSONAJES" con lo ocurrido en el final.
4. Genera los "GUIONES DE PODCAST" y el "MAPA MERMAID" basados en la obra COMPLETA.

### RESTRICCIONES TÉCNICAS:
- Idioma: Español de España.
- Responde ÚNICAMENTE en JSON con la misma estructura.
`;

  const analysis2 = await runAnalysis(ai, model, prompt2, "SEGUNDA PARTE (FINAL)");

  // MERGE RESULTS
  console.log("[Gemini Backend] Merging analysis results...");
  return {
    ...analysis1,
    resumen_general: analysis2.resumen_general,
    resumen_detallado_capitulos: analysis1.resumen_detallado_capitulos + "\n\n" + analysis2.resumen_detallado_capitulos,
    analisis_personajes: analysis2.analisis_personajes,
    evolucion_protagonista: analysis2.evolucion_protagonista,
    mermaid_code: analysis2.mermaid_code,
    guion_podcast_personajes: analysis2.guion_podcast_personajes,
    guion_podcast_libro: analysis2.guion_podcast_libro
  };
};

async function runAnalysis(ai: any, model: string, text: string, phaseName: string = "ANALYSIS") {
  const prompt = phaseName === "ANALYSIS" ? `
Actúas como el motor lógico de "Mi Biblioteca Personal NAS", un sistema de gestión del conocimiento (PKM). Tu misión es analizar el siguiente contenido de libro y devolver información estructurada exclusivamente en formato JSON.

### CONTENIDO DEL LIBRO:
${text}

### REGLAS DE ANÁLISIS (MODO SPOILER TOTAL):
1. FICHA TÉCNICA: Extrae el título, autor, ISBN (si lo encuentras, si no, busca el ISBN real de este libro), una sinopsis atractiva, biografía del autor, bibliografía destacada del autor y datos de publicación (año, género, editorial).
2. RESUMEN GENERAL: Crea un resumen genérico del libro entero, capturando la esencia, trama principal y conclusión.
3. RESUMEN DETALLADO POR CAPÍTULOS: Crea un desglose EXTREMADAMENTE DETALLADO capítulo a capítulo. Es OBLIGATORIO incluir spoilers, finales, giros de guion, revelaciones y detalles minuciosos.
4. PERSONAJES: Analiza su psicología, motivaciones y su arco de evolución.
5. MAPA DE IDEAS: Genera código funcional en formato Mermaid.js.
6. PODCASTS: Redacta dos guiones dinámicos en español de España.

### RESTRICCIONES TÉCNICAS:
- Idioma: Español de España.
- Salida: JSON puro.
- Estructura JSON: { "titulo": "", "autor": "", "isbn": "", "sinopsis": "", "biografia_autor": "", "bibliografia_autor": "", "datos_publicacion": "", "resumen_general": "", "resumen_detallado_capitulos": "", "resumen_capitulos": "", "analisis_personajes": "", "evolucion_protagonista": "", "mermaid_code": "", "guion_podcast_personajes": "", "guion_podcast_libro": "" }
` : text;

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
