import React, { useState, useEffect, useRef } from 'react';
import { 
  Book, Upload, Search, Trash2, Brain, Mic2, FileText, Network,
  Loader2, Plus, X, History, LogOut, ShieldAlert, Users, Library
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { analyzeBook, BookAnalysis } from '../../services/geminiService';
import mermaid from 'mermaid';
import Markdown from 'react-markdown';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { useAuth } from '../../contexts/AuthContext';
import Setup2FA from '../Auth/Setup2FA';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

interface SavedBook extends BookAnalysis {
  id: number;
  created_at: string;
}

interface Library {
  id: number;
  name: string;
  role: string;
}

export default function Dashboard() {
  const { user, token, logout } = useAuth();
  const [libraries, setLibraries] = useState<Library[]>([]);
  const [selectedLibrary, setSelectedLibrary] = useState<Library | null>(null);
  const [books, setBooks] = useState<SavedBook[]>([]);
  const [selectedBook, setSelectedBook] = useState<SavedBook | null>(null);
  
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisProgress, setAnalysisProgress] = useState(0);
  const [analysisMessage, setAnalysisMessage] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [activeTab, setActiveTab] = useState<'ficha' | 'resumen' | 'personajes' | 'mapa' | 'podcasts'>('ficha');
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [showNewLibModal, setShowNewLibModal] = useState(false);
  const [show2FA, setShow2FA] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const mermaidRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchLibraries();
    mermaid.initialize({ startOnLoad: true, theme: 'dark' });
  }, []);

  useEffect(() => {
    if (selectedLibrary) {
      fetchBooks(selectedLibrary.id);
      setSelectedBook(null);
    }
  }, [selectedLibrary]);

  useEffect(() => {
    if (selectedBook && activeTab === 'mapa' && mermaidRef.current) {
      mermaidRef.current.innerHTML = '';
      const renderMermaid = async () => {
        try {
          const { svg } = await mermaid.render('mermaid-diagram', selectedBook.mermaid_code);
          if (mermaidRef.current) mermaidRef.current.innerHTML = svg;
        } catch (err) {
          console.error('Mermaid render error:', err);
        }
      };
      renderMermaid();
    }
  }, [selectedBook, activeTab]);

  const fetchLibraries = async () => {
    try {
      const res = await fetch('/api/libraries', {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      setLibraries(data);
      if (data.length > 0 && !selectedLibrary) {
        setSelectedLibrary(data[0]);
      }
    } catch (err) {
      console.error('Error fetching libraries:', err);
    }
  };

  const fetchBooks = async (libraryId: number) => {
    try {
      const res = await fetch(`/api/libraries/${libraryId}/books`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      setBooks(data);
    } catch (err) {
      console.error('Error fetching books:', err);
    }
  };

  const handleCreateLibrary = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    const name = formData.get('name') as string;
    
    try {
      const res = await fetch('/api/libraries', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ name })
      });
      const newLib = await res.json();
      setLibraries([...libraries, newLib]);
      setSelectedLibrary(newLib);
      setShowNewLibModal(false);
    } catch (err) {
      setError('Error al crear biblioteca');
    }
  };

  const handleInvite = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!selectedLibrary) return;
    
    const formData = new FormData(e.currentTarget);
    const email = formData.get('email') as string;
    const role = formData.get('role') as string;
    
    try {
      const res = await fetch(`/api/libraries/${selectedLibrary.id}/invite`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ email, role })
      });
      
      if (res.ok) {
        setSuccessMsg('Invitación enviada con éxito');
        setShowInviteModal(false);
      } else {
        const data = await res.json();
        setError(data.error);
      }
    } catch (err) {
      setError('Error al enviar invitación');
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !selectedLibrary) return;

    setIsAnalyzing(true);
    setError(null);
    setShowUploadModal(false);

    try {
      const reader = new FileReader();
      reader.onload = async (event) => {
        const content = event.target?.result as string;
        try {
          const analysis = await analyzeBook(
            content || "Contenido de prueba para el libro: " + file.name, 
            token || "",
            (progress, message) => {
              setAnalysisProgress(progress);
              setAnalysisMessage(message);
            }
          );
          
          const saveRes = await fetch(`/api/libraries/${selectedLibrary.id}/books`, {
            method: 'POST',
            headers: { 
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`
            },
            body: JSON.stringify(analysis)
          });
          
          if (!saveRes.ok) throw new Error('Error al guardar');
          
          const { id } = await saveRes.json();
          const newBook = { ...analysis, id, created_at: new Date().toISOString() };
          setBooks([newBook, ...books]);
          setSelectedBook(newBook);
          setSuccessMsg('Análisis completado y guardado con éxito');
        } catch (err: any) {
          setError(err.message || "Error analizando el libro. Por favor, inténtalo de nuevo.");
          console.error(err);
        } finally {
          setIsAnalyzing(false);
          setAnalysisProgress(0);
          setAnalysisMessage('');
        }
      };
      reader.readAsText(file);
    } catch (err) {
      setIsAnalyzing(false);
      setError("Error al leer el archivo.");
    }
  };

  const deleteBook = async (id: number) => {
    if (!confirm('¿Estás seguro de que quieres eliminar este análisis?')) return;
    try {
      await fetch(`/api/books/${id}`, { 
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      setBooks(books.filter(b => b.id !== id));
      if (selectedBook?.id === id) setSelectedBook(null);
    } catch (err) {
      console.error('Error deleting book:', err);
    }
  };

  const filteredBooks = books.filter(b => 
    b.titulo.toLowerCase().includes(searchTerm.toLowerCase()) || 
    b.autor.toLowerCase().includes(searchTerm.toLowerCase())
  );

  if (show2FA) {
    return (
      <div className="min-h-screen bg-[#0A0A0A] p-4">
        <button onClick={() => setShow2FA(false)} className="text-[#8E9299] hover:text-white mb-4 flex items-center gap-2 text-xs uppercase font-bold">
          <X className="w-4 h-4" /> Volver al Dashboard
        </button>
        <Setup2FA onComplete={() => {
          setShow2FA(false);
          setSuccessMsg('2FA activado correctamente');
        }} />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0A0A0A] text-[#E4E3E0] font-sans selection:bg-[#F27D26] selection:text-black">
      {/* Header */}
      <header className="border-b border-[#141414] p-4 flex items-center justify-between bg-[#0A0A0A]/80 backdrop-blur-md sticky top-0 z-40">
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-[#F27D26] rounded-lg flex items-center justify-center">
              <Book className="text-black w-6 h-6" />
            </div>
            <div>
              <h1 className="text-lg font-bold tracking-tight uppercase">Bookreminder</h1>
              <p className="text-[10px] text-[#8E9299] uppercase tracking-widest font-mono">Knowledge Management System v1.0</p>
            </div>
          </div>

          <div className="h-8 w-px bg-[#141414] hidden md:block"></div>

          <div className="hidden md:flex items-center gap-2">
            <Library className="w-4 h-4 text-[#8E9299]" />
            <select 
              className="bg-transparent border-none text-sm font-bold uppercase focus:outline-none cursor-pointer"
              value={selectedLibrary?.id || ''}
              onChange={(e) => {
                const lib = libraries.find(l => l.id === Number(e.target.value));
                if (lib) setSelectedLibrary(lib);
              }}
            >
              {libraries.map(lib => (
                <option key={lib.id} value={lib.id} className="bg-[#0D0D0D]">{lib.name}</option>
              ))}
            </select>
            <button onClick={() => setShowNewLibModal(true)} className="ml-2 text-[#8E9299] hover:text-[#F27D26] transition-colors" title="Nueva Biblioteca">
              <Plus className="w-4 h-4" />
            </button>
          </div>
        </div>
        
        <div className="flex items-center gap-4">
          <div className="relative hidden lg:block">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#8E9299]" />
            <input 
              type="text" 
              placeholder="BUSCAR EN LA BIBLIOTECA..."
              className="bg-[#141414] border border-[#1A1A1A] rounded-full py-2 pl-10 pr-4 text-xs focus:outline-none focus:border-[#F27D26] transition-colors w-64 uppercase font-mono"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </div>
          
          {selectedLibrary?.role !== 'viewer' && (
            <button 
              onClick={() => setShowUploadModal(true)}
              className="bg-[#F27D26] hover:bg-[#FF8C37] text-black px-4 py-2 rounded-full text-xs font-bold transition-all flex items-center gap-2 uppercase"
            >
              <Plus className="w-4 h-4" />
              <span className="hidden sm:inline">Nuevo Análisis</span>
            </button>
          )}

          <div className="flex items-center gap-3 ml-2 pl-4 border-l border-[#141414]">
            {!user?.is_totp_enabled && (
              <button onClick={() => setShow2FA(true)} className="text-[#F27D26] hover:text-[#FF8C37] transition-colors" title="Configurar 2FA">
                <ShieldAlert className="w-5 h-5" />
              </button>
            )}
            {selectedLibrary?.role === 'owner' && (
              <button onClick={() => setShowInviteModal(true)} className="text-[#8E9299] hover:text-white transition-colors" title="Invitar Usuarios">
                <Users className="w-5 h-5" />
              </button>
            )}
            <button onClick={logout} className="text-[#8E9299] hover:text-red-500 transition-colors" title="Cerrar Sesión">
              <LogOut className="w-5 h-5" />
            </button>
          </div>
        </div>
      </header>

      <main className="flex h-[calc(100vh-73px)] overflow-hidden">
        {/* Sidebar */}
        <aside className="w-80 border-r border-[#141414] flex flex-col bg-[#0D0D0D]">
          <div className="p-4 border-b border-[#141414] flex items-center justify-between">
            <span className="text-[10px] font-mono text-[#8E9299] uppercase tracking-widest">Colección Reciente</span>
            <History className="w-4 h-4 text-[#8E9299]" />
          </div>
          <div className="flex-1 overflow-y-auto custom-scrollbar">
            {filteredBooks.map((book) => (
              <button
                key={book.id}
                onClick={() => setSelectedBook(book)}
                className={cn(
                  "w-full p-4 border-b border-[#141414] text-left transition-all group relative",
                  selectedBook?.id === book.id ? "bg-[#141414]" : "hover:bg-[#111111]"
                )}
              >
                <div className="flex justify-between items-start mb-1">
                  <h3 className={cn(
                    "text-sm font-bold truncate pr-6",
                    selectedBook?.id === book.id ? "text-[#F27D26]" : "text-[#E4E3E0]"
                  )}>
                    {book.titulo}
                  </h3>
                  {selectedLibrary?.role !== 'viewer' && (
                    <Trash2 
                      className="w-4 h-4 text-[#333] hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity absolute right-4 top-4" 
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteBook(book.id);
                      }}
                    />
                  )}
                </div>
                <p className="text-xs text-[#8E9299] italic font-serif">{book.autor}</p>
                <div className="mt-3 flex items-center gap-2">
                  <span className="text-[9px] font-mono bg-[#1A1A1A] px-1.5 py-0.5 rounded text-[#555]">
                    {new Date(book.created_at).toLocaleDateString()}
                  </span>
                </div>
              </button>
            ))}
            {filteredBooks.length === 0 && !isAnalyzing && (
              <div className="p-8 text-center">
                <p className="text-xs text-[#555] font-mono uppercase">No hay libros analizados</p>
              </div>
            )}
            {isAnalyzing && (
              <div className="p-4 border-b border-[#141414] bg-[#141414]/50">
                <div className="flex items-center gap-3 mb-2">
                  <Loader2 className="w-4 h-4 animate-spin text-[#F27D26]" />
                  <span className="text-xs font-mono text-[#F27D26] uppercase">Procesando con IA...</span>
                </div>
                <div className="w-full bg-[#1A1A1A] h-1 rounded-full overflow-hidden">
                  <motion.div 
                    className="h-full bg-[#F27D26]"
                    initial={{ width: 0 }}
                    animate={{ width: `${analysisProgress}%` }}
                  />
                </div>
                <div className="flex justify-between mt-1">
                  <p className="text-[9px] font-mono text-[#F27D26] uppercase truncate max-w-[180px]">{analysisMessage}</p>
                  <p className="text-[9px] font-mono text-[#555]">{analysisProgress}%</p>
                </div>
              </div>
            )}
          </div>
        </aside>

        {/* Content Area */}
        <section className="flex-1 overflow-y-auto bg-[#0A0A0A] relative">
          <AnimatePresence mode="wait">
            {selectedBook ? (
              <motion.div 
                key={selectedBook.id}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="p-8 max-w-5xl mx-auto"
              >
                {/* Book Header */}
                <div className="mb-12 border-b border-[#141414] pb-8">
                  <div className="flex items-center gap-2 mb-4">
                    <span className="text-[10px] font-mono text-[#F27D26] border border-[#F27D26]/30 px-2 py-0.5 rounded-full uppercase">Análisis Completo</span>
                    <span className="text-[10px] font-mono text-[#8E9299] uppercase">ID: {selectedBook.id.toString().padStart(4, '0')}</span>
                  </div>
                  <h2 className="text-5xl font-bold tracking-tighter mb-2 leading-none">{selectedBook.titulo}</h2>
                  <p className="text-xl font-serif italic text-[#8E9299]">{selectedBook.autor}</p>
                </div>

                {/* Tabs */}
                <div className="flex gap-8 border-b border-[#141414] mb-8 overflow-x-auto no-scrollbar">
                  {[
                    { id: 'ficha', label: 'Ficha Técnica', icon: Book },
                    { id: 'resumen', label: 'Resumen Riguroso', icon: FileText },
                    { id: 'personajes', label: 'Psicología & Evolución', icon: Brain },
                    { id: 'mapa', label: 'Mapa de Ideas', icon: Network },
                    { id: 'podcasts', label: 'Guiones Podcast', icon: Mic2 },
                  ].map((tab) => (
                    <button
                      key={tab.id}
                      onClick={() => setActiveTab(tab.id as any)}
                      className={cn(
                        "flex items-center gap-2 pb-4 text-xs font-bold uppercase tracking-widest transition-all relative",
                        activeTab === tab.id ? "text-[#F27D26]" : "text-[#555] hover:text-[#8E9299]"
                      )}
                    >
                      <tab.icon className="w-4 h-4" />
                      {tab.label}
                      {activeTab === tab.id && (
                        <motion.div 
                          layoutId="activeTab"
                          className="absolute bottom-0 left-0 right-0 h-0.5 bg-[#F27D26]"
                        />
                      )}
                    </button>
                  ))}
                </div>

                {/* Tab Content */}
                <div className="min-h-[400px]">
                  {activeTab === 'ficha' && (
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
                      <div className="md:col-span-1">
                        {selectedBook.isbn ? (
                          <div className="bg-[#0D0D0D] border border-[#141414] rounded-xl overflow-hidden aspect-[2/3] relative flex items-center justify-center">
                            <img 
                              src={`https://covers.openlibrary.org/b/isbn/${selectedBook.isbn.replace(/[^0-9X]/gi, '')}-L.jpg`} 
                              alt={`Portada de ${selectedBook.titulo}`}
                              className="w-full h-full object-cover opacity-80 hover:opacity-100 transition-opacity"
                              onError={(e) => {
                                (e.target as HTMLImageElement).style.display = 'none';
                                (e.target as HTMLImageElement).nextElementSibling?.classList.remove('hidden');
                              }}
                            />
                            <div className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center hidden bg-[#141414]">
                              <Book className="w-12 h-12 text-[#333] mb-4" />
                              <span className="text-xs text-[#555] font-mono uppercase">Portada no disponible</span>
                            </div>
                          </div>
                        ) : (
                          <div className="bg-[#141414] rounded-xl aspect-[2/3] flex flex-col items-center justify-center p-6 text-center border border-[#1A1A1A]">
                            <Book className="w-12 h-12 text-[#333] mb-4" />
                            <span className="text-xs text-[#555] font-mono uppercase">Sin ISBN</span>
                          </div>
                        )}
                        
                        <div className="mt-6 space-y-4">
                          <div>
                            <h4 className="text-[10px] font-mono text-[#8E9299] uppercase tracking-widest mb-1">ISBN</h4>
                            <p className="text-sm font-mono text-[#E4E3E0]">{selectedBook.isbn || 'No especificado'}</p>
                          </div>
                          <div>
                            <h4 className="text-[10px] font-mono text-[#8E9299] uppercase tracking-widest mb-1">Datos de Publicación</h4>
                            <p className="text-sm text-[#E4E3E0]">{selectedBook.datos_publicacion || 'No especificado'}</p>
                          </div>
                        </div>
                      </div>
                      
                      <div className="md:col-span-2 space-y-8">
                        <section>
                          <h4 className="text-[10px] font-mono text-[#F27D26] uppercase tracking-[0.2em] mb-4">Sinopsis</h4>
                          <div className="bg-[#0D0D0D] border border-[#141414] p-6 rounded-xl leading-relaxed text-[#B0B0B0] font-serif text-lg">
                            <Markdown>{selectedBook.sinopsis || 'Sinopsis no disponible.'}</Markdown>
                          </div>
                        </section>
                        
                        <section>
                          <h4 className="text-[10px] font-mono text-[#F27D26] uppercase tracking-[0.2em] mb-4">Biografía del Autor</h4>
                          <div className="bg-[#0D0D0D] border border-[#141414] p-6 rounded-xl leading-relaxed text-[#B0B0B0]">
                            <Markdown>{selectedBook.biografia_autor || 'Biografía no disponible.'}</Markdown>
                          </div>
                        </section>
                        
                        <section>
                          <h4 className="text-[10px] font-mono text-[#F27D26] uppercase tracking-[0.2em] mb-4">Bibliografía Destacada</h4>
                          <div className="bg-[#0D0D0D] border border-[#141414] p-6 rounded-xl leading-relaxed text-[#B0B0B0]">
                            <Markdown>{selectedBook.bibliografia_autor || 'Bibliografía no disponible.'}</Markdown>
                          </div>
                        </section>
                      </div>
                    </div>
                  )}

                  {activeTab === 'resumen' && (
                    <div className="prose prose-invert max-w-none">
                      <div className="grid grid-cols-1 gap-12">
                        <section>
                          <h4 className="text-[10px] font-mono text-[#F27D26] uppercase tracking-[0.2em] mb-4">Resumen General</h4>
                          <div className="bg-[#0D0D0D] border border-[#141414] p-6 rounded-xl leading-relaxed text-[#E4E3E0] font-serif text-xl border-l-4 border-l-[#F27D26]">
                            <Markdown>{selectedBook.resumen_general || 'Resumen general no disponible.'}</Markdown>
                          </div>
                        </section>
                        
                        <section>
                          <h4 className="text-[10px] font-mono text-[#F27D26] uppercase tracking-[0.2em] mb-4">Desglose Detallado por Capítulos (Modo Spoiler)</h4>
                          <div className="bg-[#0D0D0D] border border-[#141414] p-8 rounded-xl leading-relaxed text-[#B0B0B0] font-serif text-lg">
                            <Markdown>{selectedBook.resumen_detallado_capitulos || selectedBook.resumen_capitulos}</Markdown>
                          </div>
                        </section>
                      </div>
                    </div>
                  )}

                  {activeTab === 'personajes' && (
                    <div className="space-y-12">
                      <section>
                        <h4 className="text-[10px] font-mono text-[#F27D26] uppercase tracking-[0.2em] mb-4">Análisis de Personajes</h4>
                        <div className="bg-[#0D0D0D] border border-[#141414] p-6 rounded-xl">
                          <div className="prose prose-invert max-w-none text-[#B0B0B0]">
                            <Markdown>{selectedBook.analisis_personajes}</Markdown>
                          </div>
                        </div>
                      </section>
                      <section>
                        <h4 className="text-[10px] font-mono text-[#F27D26] uppercase tracking-[0.2em] mb-4">Arco de Evolución Protagonista</h4>
                        <div className="bg-[#0D0D0D] border border-[#141414] p-6 rounded-xl border-l-4 border-l-[#F27D26]">
                          <div className="prose prose-invert max-w-none text-[#B0B0B0] italic">
                            <Markdown>{selectedBook.evolucion_protagonista}</Markdown>
                          </div>
                        </div>
                      </section>
                    </div>
                  )}

                  {activeTab === 'mapa' && (
                    <div className="bg-[#0D0D0D] border border-[#141414] p-8 rounded-xl flex justify-center overflow-x-auto">
                      <div ref={mermaidRef} className="mermaid-container" />
                    </div>
                  )}

                  {activeTab === 'podcasts' && (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                      <div className="bg-[#0D0D0D] border border-[#141414] p-6 rounded-xl relative overflow-hidden group">
                        <div className="absolute top-0 right-0 p-4 opacity-10">
                          <Mic2 className="w-16 h-16" />
                        </div>
                        <h5 className="text-sm font-bold uppercase mb-4 flex items-center gap-2">
                          <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                          Podcast Personajes
                        </h5>
                        <div className="text-xs text-[#8E9299] font-mono leading-relaxed whitespace-pre-wrap max-h-[500px] overflow-y-auto custom-scrollbar pr-2">
                          {selectedBook.guion_podcast_personajes}
                        </div>
                      </div>
                      <div className="bg-[#0D0D0D] border border-[#141414] p-6 rounded-xl relative overflow-hidden group">
                        <div className="absolute top-0 right-0 p-4 opacity-10">
                          <Mic2 className="w-16 h-16" />
                        </div>
                        <h5 className="text-sm font-bold uppercase mb-4 flex items-center gap-2">
                          <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
                          Podcast Resumen
                        </h5>
                        <div className="text-xs text-[#8E9299] font-mono leading-relaxed whitespace-pre-wrap max-h-[500px] overflow-y-auto custom-scrollbar pr-2">
                          {selectedBook.guion_podcast_libro}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </motion.div>
            ) : (
              <div className="h-full flex flex-col items-center justify-center p-8 text-center">
                <div className="w-24 h-24 bg-[#141414] rounded-full flex items-center justify-center mb-6">
                  <Book className="w-10 h-10 text-[#333]" />
                </div>
                <h3 className="text-2xl font-bold tracking-tight mb-2 uppercase">Selecciona un libro</h3>
                <p className="text-[#555] max-w-md font-serif italic">
                  Explora tu biblioteca personal o sube un nuevo archivo para generar un análisis profundo con inteligencia artificial.
                </p>
                {selectedLibrary?.role !== 'viewer' && (
                  <button 
                    onClick={() => setShowUploadModal(true)}
                    className="mt-8 border border-[#333] hover:border-[#F27D26] hover:text-[#F27D26] px-6 py-3 rounded-full text-xs font-bold transition-all uppercase tracking-widest"
                  >
                    Comenzar Análisis
                  </button>
                )}
              </div>
            )}
          </AnimatePresence>
        </section>
      </main>

      {/* Modals */}
      <AnimatePresence>
        {showUploadModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              onClick={() => setShowUploadModal(false)}
              className="absolute inset-0 bg-black/80 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.9, opacity: 0 }}
              className="bg-[#0D0D0D] border border-[#1A1A1A] w-full max-w-md rounded-2xl overflow-hidden relative z-10"
            >
              <div className="p-6 border-b border-[#1A1A1A] flex items-center justify-between">
                <h3 className="text-sm font-bold uppercase tracking-widest">Subir Nuevo Libro</h3>
                <button onClick={() => setShowUploadModal(false)} className="text-[#555] hover:text-white">
                  <X className="w-5 h-5" />
                </button>
              </div>
              <div className="p-8">
                <label className="group block border-2 border-dashed border-[#1A1A1A] hover:border-[#F27D26] transition-all rounded-xl p-12 text-center cursor-pointer">
                  <input type="file" className="hidden" accept=".pdf,.epub,.txt" onChange={handleFileUpload} />
                  <div className="w-16 h-16 bg-[#141414] group-hover:bg-[#F27D26] group-hover:text-black transition-all rounded-full flex items-center justify-center mx-auto mb-4">
                    <Upload className="w-8 h-8" />
                  </div>
                  <p className="text-sm font-bold uppercase mb-1">Haz clic o arrastra</p>
                  <p className="text-[10px] text-[#555] font-mono uppercase">PDF, EPUB o TXT (Máx 50MB)</p>
                </label>
              </div>
            </motion.div>
          </div>
        )}

        {showNewLibModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              onClick={() => setShowNewLibModal(false)}
              className="absolute inset-0 bg-black/80 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.9, opacity: 0 }}
              className="bg-[#0D0D0D] border border-[#1A1A1A] w-full max-w-md rounded-2xl overflow-hidden relative z-10"
            >
              <div className="p-6 border-b border-[#1A1A1A] flex items-center justify-between">
                <h3 className="text-sm font-bold uppercase tracking-widest">Nueva Biblioteca</h3>
                <button onClick={() => setShowNewLibModal(false)} className="text-[#555] hover:text-white">
                  <X className="w-5 h-5" />
                </button>
              </div>
              <form onSubmit={handleCreateLibrary} className="p-6 space-y-4">
                <div>
                  <label className="block text-[10px] font-mono text-[#8E9299] uppercase tracking-widest mb-2">Nombre de la biblioteca</label>
                  <input
                    type="text"
                    name="name"
                    required
                    className="w-full bg-[#141414] border border-[#1A1A1A] rounded-lg py-3 px-4 text-sm focus:outline-none focus:border-[#F27D26] transition-colors text-[#E4E3E0]"
                    placeholder="Ej: Fantasía Épica"
                  />
                </div>
                <button type="submit" className="w-full bg-[#F27D26] hover:bg-[#FF8C37] text-black font-bold py-3 rounded-lg text-xs uppercase tracking-widest transition-all">
                  Crear
                </button>
              </form>
            </motion.div>
          </div>
        )}

        {showInviteModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              onClick={() => setShowInviteModal(false)}
              className="absolute inset-0 bg-black/80 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.9, opacity: 0 }}
              className="bg-[#0D0D0D] border border-[#1A1A1A] w-full max-w-md rounded-2xl overflow-hidden relative z-10"
            >
              <div className="p-6 border-b border-[#1A1A1A] flex items-center justify-between">
                <h3 className="text-sm font-bold uppercase tracking-widest">Invitar a Biblioteca</h3>
                <button onClick={() => setShowInviteModal(false)} className="text-[#555] hover:text-white">
                  <X className="w-5 h-5" />
                </button>
              </div>
              <form onSubmit={handleInvite} className="p-6 space-y-4">
                <div>
                  <label className="block text-[10px] font-mono text-[#8E9299] uppercase tracking-widest mb-2">Email del usuario</label>
                  <input
                    type="email"
                    name="email"
                    required
                    className="w-full bg-[#141414] border border-[#1A1A1A] rounded-lg py-3 px-4 text-sm focus:outline-none focus:border-[#F27D26] transition-colors text-[#E4E3E0]"
                    placeholder="colaborador@email.com"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-mono text-[#8E9299] uppercase tracking-widest mb-2">Rol</label>
                  <select name="role" className="w-full bg-[#141414] border border-[#1A1A1A] rounded-lg py-3 px-4 text-sm focus:outline-none focus:border-[#F27D26] transition-colors text-[#E4E3E0]">
                    <option value="editor">Editor (Puede añadir/borrar)</option>
                    <option value="viewer">Lector (Solo lectura)</option>
                  </select>
                </div>
                <button type="submit" className="w-full bg-[#F27D26] hover:bg-[#FF8C37] text-black font-bold py-3 rounded-lg text-xs uppercase tracking-widest transition-all">
                  Enviar Invitación
                </button>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Toasts */}
      <AnimatePresence>
        {error && (
          <motion.div 
            initial={{ y: 100, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 100, opacity: 0 }}
            className="fixed bottom-8 right-8 bg-red-950 border border-red-500 text-red-200 px-6 py-4 rounded-xl shadow-2xl z-50 flex items-center gap-3"
          >
            <X className="w-5 h-5 cursor-pointer" onClick={() => setError(null)} />
            <span className="text-xs font-bold uppercase tracking-widest">{error}</span>
          </motion.div>
        )}
        {successMsg && (
          <motion.div 
            initial={{ y: 100, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 100, opacity: 0 }}
            className="fixed bottom-8 right-8 bg-green-950 border border-green-500 text-green-200 px-6 py-4 rounded-xl shadow-2xl z-50 flex items-center gap-3"
          >
            <X className="w-5 h-5 cursor-pointer" onClick={() => setSuccessMsg(null)} />
            <span className="text-xs font-bold uppercase tracking-widest">{successMsg}</span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
