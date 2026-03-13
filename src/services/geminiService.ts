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

export const analyzeBook = async (
  content: string, 
  token: string, 
  libraryId: number,
  onProgress?: (progress: number, message: string, logs: string[], partialResult: any) => void
): Promise<BookAnalysis> => {
  const response = await fetch('/api/analyze', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({ content, libraryId })
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error || "Error starting analysis");
  }

  const { jobId } = await response.json();

  // Polling
  return new Promise((resolve, reject) => {
    const poll = async () => {
      try {
        const res = await fetch(`/api/analysis-status/${jobId}`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        
        if (!res.ok) throw new Error("Error checking status");
        
        const data = await res.json();
        
        if (onProgress && data.progress !== undefined) {
          onProgress(data.progress, data.message || "", data.logs || [], data.partialResult);
        }

        if (data.status === 'completed') {
          resolve(data.result);
        } else if (data.status === 'failed') {
          reject(new Error(data.error || "Analysis failed"));
        } else {
          setTimeout(poll, 3000); // Poll every 3 seconds
        }
      } catch (err) {
        reject(err);
      }
    };
    poll();
  });
};
