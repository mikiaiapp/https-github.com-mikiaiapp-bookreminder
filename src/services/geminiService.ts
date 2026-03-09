export interface BookAnalysis {
  titulo: string;
  autor: string;
  isbn: string;
  sinopsis: string;
  biografia_autor: string;
  bibliografia_autor: string;
  datos_publicacion: string;
  resumen_general: string;
  resumen_detallado_capitulos: string;
  resumen_capitulos: string; // Keeping for backward compatibility if needed, or we can just map it
  analisis_personajes: string;
  evolucion_protagonista: string;
  mermaid_code: string;
  guion_podcast_personajes: string;
  guion_podcast_libro: string;
}

export const analyzeBook = async (content: string, token: string): Promise<BookAnalysis> => {
  const response = await fetch('/api/analyze', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({ content })
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error || "Error analyzing book via backend");
  }

  return response.json();
};
