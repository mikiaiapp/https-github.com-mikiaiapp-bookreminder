import { GoogleGenAI, Type } from "@google/genai";

export const analyzeBookBackend = async (content: string) => {
  console.log("[Gemini Backend] Initializing GoogleGenAI...");
  const apiKey = process.env.GEMINI_API_KEY || "";
  if (!apiKey) {
    console.error("[Gemini Backend] CRITICAL ERROR: GEMINI_API_KEY is not set or is empty!");
  } else {
    console.log(`[Gemini Backend] GEMINI_API_KEY is set (length: ${apiKey.length})`);
  }
  
  const ai = new GoogleGenAI({ apiKey });
  const model = "gemini-3.1-pro-preview";
  
  console.log(`[Gemini Backend] Preparing prompt for model: ${model}`);
  
  const prompt = `
Actúas como el motor lógico de "Mi Biblioteca Personal NAS", un sistema de gestión del conocimiento (PKM). Tu misión es analizar el siguiente contenido de libro y devolver información estructurada exclusivamente en formato JSON.

### CONTENIDO DEL LIBRO:
${content.substring(0, 3500000)}

### REGLAS DE ANÁLISIS (MODO SPOILER TOTAL):
1. FICHA TÉCNICA: Extrae el título, autor, ISBN (si lo encuentras, si no, busca el ISBN real de este libro), una sinopsis atractiva, biografía del autor, bibliografía destacada del autor y datos de publicación (año, género, editorial).
2. RESUMEN GENERAL: Crea un resumen genérico del libro entero, capturando la esencia, trama principal y conclusión.
3. RESUMEN DETALLADO POR CAPÍTULOS: Crea un desglose EXTREMADAMENTE DETALLADO capítulo a capítulo. Es OBLIGATORIO incluir spoilers, finales, giros de guion, revelaciones y detalles minuciosos. El objetivo es que el usuario, al leer esto años después, tenga el recuerdo íntegro del libro con la máxima información posible.
4. PERSONAJES: Analiza su psicología, motivaciones y su arco de evolución desde el inicio hasta el desenlace.
5. MAPA DE IDEAS: Genera código funcional en formato Mermaid.js que conecte temas, tramas y símbolos.
6. PODCASTS (ESTILO NOTEBOOK LM): Redacta dos guiones dinámicos en español de España:
   - "Podcast Personajes": Un diálogo profundo sobre la evolución de los protagonistas.
   - "Podcast Resumen": Una narración envolvente del viaje completo de la obra.

### RESTRICCIONES TÉCNICAS:
- Idioma: Español de España.
- Salida: Responde ÚNICAMENTE con el objeto JSON puro, sin bloques de código Markdown (sin \`\`\`json), sin introducciones ni despedidas.
- Estructura JSON: { "titulo": "", "autor": "", "isbn": "", "sinopsis": "", "biografia_autor": "", "bibliografia_autor": "", "datos_publicacion": "", "resumen_general": "", "resumen_detallado_capitulos": "", "resumen_capitulos": "", "analisis_personajes": "", "evolucion_protagonista": "", "mermaid_code": "", "guion_podcast_personajes": "", "guion_podcast_libro": "" }
`;

  console.log("[Gemini Backend] Sending request to Gemini API...");
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

    console.log("[Gemini Backend] Received response from Gemini API");
    const text = response.text;
    
    if (!text) {
      console.error("[Gemini Backend] Error: Response text is empty");
      throw new Error("No response from Gemini");
    }
    
    console.log(`[Gemini Backend] Parsing JSON response (length: ${text.length})...`);
    try {
      const parsed = JSON.parse(text);
      console.log("[Gemini Backend] JSON parsed successfully");
      return parsed;
    } catch (parseError) {
      console.error("[Gemini Backend] Error parsing JSON:", parseError);
      console.error("[Gemini Backend] Raw text received:", text.substring(0, 500) + "...");
      throw new Error("Failed to parse JSON response from Gemini");
    }
  } catch (apiError: any) {
    console.error("[Gemini Backend] Exception during Gemini API call:", apiError);
    if (apiError.status) console.error(`[Gemini Backend] Status code: ${apiError.status}`);
    throw apiError;
  }
};
