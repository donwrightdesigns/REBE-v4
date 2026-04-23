'use client';

import { useState, useEffect, useCallback } from 'react';
import { useAuth } from './auth-provider';
import { db } from '@/lib/firebase';
import { doc, getDoc, updateDoc, collection, query, where, orderBy, onSnapshot, addDoc, deleteDoc } from 'firebase/firestore';
import { Button } from './ui/button';
import Image from 'next/image';
import { UploadCloud, CheckCircle2, Loader2, Image as ImageIcon, Sparkles, Trash2 } from 'lucide-react';
import { useDropzone } from 'react-dropzone';
import { compressImage, storeHighResImage, deleteHighResImage, getHighResImage, convertToJpg, imageToApiJpeg } from '@/lib/image-utils';
import { GoogleGenAI } from '@google/genai';
import ImageModal from './image-modal';
import VoicePrompt from './voice-prompt';
import CameraCapture from './camera-capture';
import JSZip from 'jszip';
import { saveAs } from 'file-saver';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface ProjectViewProps {
  projectId: string;
  onBack: () => void;
}

interface ProjectImage {
  id: string;
  uid: string;
  projectId: string;
  originalThumbnail: string;
  processedThumbnail?: string;
  finalThumbnail?: string;
  status: 'pending' | 'analyzing' | 'processing' | 'done' | 'error' | 'final';
  analysis?: string;
  resolution?: string;
  processingStage?: string;
  flagForRedo?: boolean;
  stage2ndPass?: boolean;
  wtf?: boolean;
  createdAt: number;
}

interface Project {
  id: string;
  name: string;
  address?: string;
  prompt?: string;
  uid: string;
  createdAt: number;
}

export default function ProjectView({ projectId, onBack }: ProjectViewProps) {
  const { user } = useAuth();
  const [project, setProject] = useState<Project | null>(null);
  const [images, setImages] = useState<ProjectImage[]>([]);
  const [prompt, setPrompt] = useState('');
  const [savedPrompts, setSavedPrompts] = useState<{ name: string; prompt: string }[]>([]);
  const [newPromptName, setNewPromptName] = useState('');
  const [isSavingPrompt, setIsSavingPrompt] = useState(false);
  const [selectedModel, setSelectedModel] = useState<'nano2' | 'pro'>('nano2');
  const [requestPriority, setRequestPriority] = useState<'FLEX' | 'BATCH'>('FLEX');
  const [targetQueue, setTargetQueue] = useState<'pending' | '2ndPass'>('pending');
  const [isUploading, setIsUploading] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingProgress, setProcessingProgress] = useState({ current: 0, total: 0 });
  const [selectedImage, setSelectedImage] = useState<ProjectImage | null>(null);
  const [filter, setFilter] = useState<'all' | 'redo' | '2ndPass' | 'wtf'>('all');
  const [isCameraOpen, setIsCameraOpen] = useState(false);
  const [isHeaderCollapsed, setIsHeaderCollapsed] = useState(false);
  const [selectedImageIds, setSelectedImageIds] = useState<Set<string>>(new Set());
  const [isSelectionMode, setIsSelectionMode] = useState(false);

  const [isGeneratingPrompt, setIsGeneratingPrompt] = useState(false);
  const [isAnalyzingAll, setIsAnalyzingAll] = useState(false);
  const [isCreatingBatch, setIsCreatingBatch] = useState(false);

  const handleFirestoreError = useCallback((error: unknown, operation: string, path: string) => {
    const errInfo = {
      error: error instanceof Error ? error.message : String(error),
      authInfo: {
        userId: user?.uid,
        email: user?.email,
        emailVerified: user?.emailVerified,
        isAnonymous: user?.isAnonymous,
      },
      operation,
      path
    };
    console.error(`Firestore Error [${operation}]:`, JSON.stringify(errInfo));
    return new Error(JSON.stringify(errInfo));
  }, [user]);

  useEffect(() => {
    if (!user || !projectId) return;

    // Fetch project metadata
    const fetchProject = async () => {
      const docRef = doc(db, 'projects', projectId);
      const docSnap = await getDoc(docRef);
      if (docSnap.exists()) {
        setProject({ id: docSnap.id, ...docSnap.data() } as Project);
        setPrompt(docSnap.data().prompt || '');
      }
    };
    fetchProject();

    // Listen to images
    const q = query(
      collection(db, 'projects', projectId, 'images'),
      where('uid', '==', user.uid),
      orderBy('createdAt', 'desc')
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const imgData: ProjectImage[] = [];
      snapshot.forEach((doc) => {
        imgData.push({ id: doc.id, ...doc.data() } as ProjectImage);
      });
      setImages(imgData);
    });

    return () => unsubscribe();
  }, [user, projectId]);

  useEffect(() => {
    if (!user) return;
    const q = query(collection(db, 'saved_prompts'), where('uid', '==', user.uid));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const prompts = snapshot.docs.map(doc => doc.data() as { name: string; prompt: string });
      setSavedPrompts(prompts);
    });
    return () => unsubscribe();
  }, [user]);

  const saveCurrentPrompt = async () => {
    if (!user || !prompt || !newPromptName) return;
    setIsSavingPrompt(true);
    try {
      await addDoc(collection(db, 'saved_prompts'), {
        uid: user.uid,
        name: newPromptName,
        prompt: prompt,
        createdAt: Date.now()
      });
      setNewPromptName('');
    } catch (error) {
      console.error('Error saving prompt:', error);
    } finally {
      setIsSavingPrompt(false);
    }
  };

  const loadPrompt = (savedPrompt: string) => {
    setPrompt(savedPrompt);
    savePrompt(savedPrompt);
  };

  const generatePromptFromAddress = async () => {
    if (!project?.address) return;
    setIsGeneratingPrompt(true);
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.NEXT_PUBLIC_GEMINI_API_KEY });
      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: `I am editing real estate photos for the property at ${project.address}. Based on this location, suggest a short, effective prompt for an AI image editor to beautify the exterior photos. IMPORTANT: The prompt MUST focus on enhancing lighting, sky, and lawn while strictly maintaining the original architectural style and scene layout. Avoid suggesting any fictional elements or significant changes to the environment.`,
        config: {
          tools: [{ googleMaps: {} }]
        }
      });
      
      if (response.text) {
        savePrompt(response.text);
      }
    } catch (error) {
      console.error('Error generating prompt from address:', error);
    } finally {
      setIsGeneratingPrompt(false);
    }
  };

  const toggleImageSelection = (id: string) => {
    const newSelection = new Set(selectedImageIds);
    if (newSelection.has(id)) {
      newSelection.delete(id);
    } else {
      newSelection.add(id);
    }
    setSelectedImageIds(newSelection);
  };

  const selectAllImages = () => {
    if (selectedImageIds.size === filteredImages.length) {
      setSelectedImageIds(new Set());
    } else {
      setSelectedImageIds(new Set(filteredImages.map(img => img.id)));
    }
  };

  const analyzeAll = async () => {
    if (images.length === 0) return;
    setIsAnalyzingAll(true);
    
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.NEXT_PUBLIC_GEMINI_API_KEY });
      const imagesToAnalyze = isSelectionMode && selectedImageIds.size > 0 
        ? images.filter(img => selectedImageIds.has(img.id))
        : images;

      const queue = [...imagesToAnalyze];
      const allAnalyses: string[] = [];
      const CONCURRENCY_LIMIT = 5; // Analytical calls are lighter but we keep it safe

      const processAnalysis = async (img: ProjectImage) => {
        if (img.analysis) {
          allAnalyses.push(img.analysis);
          return;
        }

        const imagePath = `projects/${projectId}/images/${img.id}`;
        try {
          await updateDoc(doc(db, imagePath), { status: 'analyzing' });
          
          const fullResBase64 = await getHighResImage(`orig_${img.id}`);
          if (!fullResBase64) return;
          
          const mimeType = fullResBase64.split(';')[0].split(':')[1];
          const base64Data = fullResBase64.split(',')[1];

          const scanResponse = await ai.models.generateContent({
            model: 'gemini-3.1-flash-image-preview',
            contents: {
              parts: [
                {
                  inlineData: {
                    data: base64Data,
                    mimeType: mimeType,
                  },
                },
                {
                  text: "Identify specific technical flaws in this real estate photo like a professional editor. Return a concise list of 'Lightroom Classic' style adjustments (e.g., Exposure, Contrast, Shadows, etc.).",
                },
              ],
            },
          });

          const analysis = scanResponse.text;
          if (analysis) {
            await updateDoc(doc(db, imagePath), { 
              analysis,
              status: 'pending'
            });
            allAnalyses.push(analysis);
          }
        } catch (error) {
          console.error(`Error analyzing image ${img.id}:`, error);
          await updateDoc(doc(db, imagePath), { status: 'pending' });
        }
      };

      const workers = [];
      for (let i = 0; i < Math.min(CONCURRENCY_LIMIT, queue.length); i++) {
        workers.push((async () => {
          while (queue.length > 0) {
            const img = queue.shift();
            if (img) await processAnalysis(img);
          }
        })());
      }

      await Promise.all(workers);

      if (allAnalyses.length > 0) {
        // Generate a summary prompt for the entire batch
        const summaryResponse = await ai.models.generateContent({
          model: 'gemini-3.1-flash-image-preview',
          contents: `Based on the following technical analyses of a batch of real estate photos, create a single, cohesive, and effective beautification prompt for an AI image editor. The prompt should address the common issues found across the batch while maintaining architectural integrity and realism. Focus on lighting, sky, and landscaping.

Analyses:
${allAnalyses.join('\n\n')}

Suggested Prompt:`,
        });

        if (summaryResponse.text) {
          savePrompt(summaryResponse.text);
        }
      }
    } catch (error) {
      console.error('Error in analyzeAll:', error);
    } finally {
      setIsAnalyzingAll(false);
    }
  };

  const savePrompt = async (newPrompt: string) => {
    setPrompt(newPrompt);
    if (!project) return;
    const projectPath = `projects/${projectId}`;
    try {
      await updateDoc(doc(db, projectPath), { prompt: newPrompt });
    } catch (error) {
      handleFirestoreError(error, 'update', projectPath);
    }
  };

  const onDrop = useCallback(async (acceptedFiles: File[]) => {
    if (!user) return;
    setIsUploading(true);
    
    for (const file of acceptedFiles) {
      try {
        // Get image resolution
        const img = new window.Image();
        const objectUrl = URL.createObjectURL(file);
        
        await new Promise((resolve, reject) => {
          img.onload = resolve;
          img.onerror = () => reject(new Error('Failed to load image for resolution check'));
          img.src = objectUrl;
        });
        
        const resolution = `${img.width}x${img.height}`;
        URL.revokeObjectURL(objectUrl);

        // Compress for Firestore thumbnail
        const thumbnail = await compressImage(file, 400, 400, 0.6);
        // Standardize to high-fidelity JPEG for IndexedDB storage and API usage
        const { previewUrl: fullRes } = await imageToApiJpeg(file);
        
        // Save to Firestore
        const imagesPath = `projects/${projectId}/images`;
        let docRef;
        try {
          docRef = await addDoc(collection(db, imagesPath), {
            uid: user.uid,
            projectId,
            originalThumbnail: thumbnail,
            status: 'pending',
            resolution,
            processingStage: 'analyzed',
            createdAt: Date.now(),
          });
        } catch (error) {
          throw handleFirestoreError(error, 'create', imagesPath);
        }
        
        // Save full res to IndexedDB
        await storeHighResImage(`orig_${docRef.id}`, fullRes);
      } catch (error: unknown) {
        console.error('Error uploading image:', error instanceof Error ? error.message : String(error));
      }
    }
    
    setIsUploading(false);
  }, [user, projectId, handleFirestoreError]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { 'image/*': [] },
  });

  const processBatch = async () => {
    if (!prompt.trim() || images.length === 0) return;
    
    let targetImages = [];
    if (isSelectionMode && selectedImageIds.size > 0) {
      targetImages = images.filter(img => selectedImageIds.has(img.id));
    } else {
      targetImages = images.filter(img => {
        if (targetQueue === 'pending') {
          return img.status === 'pending' || img.status === 'error';
        } else {
          return img.stage2ndPass;
        }
      });
    }

    if (targetImages.length === 0) return;
    
    setIsProcessing(true);
    setProcessingProgress({ current: 0, total: targetImages.length });
    
    let completedCount = 0;
    const CONCURRENCY_LIMIT = 10;
    const queue = [...targetImages];
    
    const processImage = async (img: ProjectImage) => {
      const imagePath = `projects/${projectId}/images/${img.id}`;
      try {
        await updateDoc(doc(db, imagePath), { status: 'processing' });
        
        const ai = new GoogleGenAI({ apiKey: process.env.NEXT_PUBLIC_GEMINI_API_KEY });
        const fullResBase64 = await getHighResImage(`orig_${img.id}`);
        
        if (!fullResBase64) throw new Error('Original image not found in local storage');
        
        const mimeType = fullResBase64.split(';')[0].split(':')[1];
        const base64Data = fullResBase64.split(',')[1];

        // 1. Pre-scan / Analysis Integration
        let currentAnalysis = img.analysis;
        if (!currentAnalysis) {
          try {
            const scanResponse = await ai.models.generateContent({
              model: 'gemini-3.1-flash-image-preview',
              contents: {
                parts: [
                  {
                    inlineData: {
                      data: base64Data,
                      mimeType: mimeType,
                    },
                  },
                  {
                    text: "Briefly identify technical flaws: lighting, sky, lawn, clarity. Technical keywords only.",
                  },
                ],
              },
            });
            currentAnalysis = scanResponse.text;
            await updateDoc(doc(db, imagePath), { analysis: currentAnalysis });
          } catch (scanError) {
            console.warn(`Pre-scan failed for image ${img.id}:`, scanError);
          }
        }

        // 2. Process with selected model and priority
        const modelName = selectedModel === 'nano2' ? 'gemini-3.1-flash-image-preview' : 'gemini-3-pro-image-preview';
        const imageSize = selectedModel === 'nano2' ? '2K' : '4K';

        // NOTE: requestPriority is passed via requestOptions/config
        const response = await ai.models.generateContent({
          model: modelName,
          contents: {
            parts: [
              {
                inlineData: {
                  data: base64Data,
                  mimeType: mimeType,
                },
              },
              {
                text: `Professional real estate photo enhancement. 
                CONSTRAINTS: Maintain architectural structure. Refine lighting, sky, landscaping.
                ANALYSIS: ${currentAnalysis || 'General enhancement'}
                PROMPT: ${prompt}`,
              },
            ],
          },
          config: {
            imageConfig: {
              aspectRatio: "16:9",
              imageSize: imageSize
            }
          }
        }, {
           // @ts-ignore - Priority strings from Tier 2 API support
           priority: requestPriority,
           timeout: 120000 
        });

        let processedBase64 = '';
        const candidate = response.candidates?.[0];
        
        if (candidate) {
          if (candidate.finishReason && candidate.finishReason !== 'STOP') {
            throw new Error(`Generation failed: ${candidate.finishReason}`);
          }
          for (const part of candidate.content?.parts || []) {
            if (part.inlineData) {
              processedBase64 = `data:image/png;base64,${part.inlineData.data}`;
              break;
            }
          }
        }

        if (processedBase64) {
          const highResKey = selectedModel === 'nano2' ? `proc_${img.id}` : `final_${img.id}`;
          await storeHighResImage(highResKey, processedBase64);
          
          const res = await fetch(processedBase64);
          const blob = await res.blob();
          const file = new File([blob], 'processed.png', { type: 'image/jpg' });
          const processedThumbnail = await compressImage(file, 400, 400, 0.6);

          const updateData: any = {
            status: selectedModel === 'nano2' ? 'done' : 'final',
            processingStage: selectedModel === 'nano2' ? 'nano2_finished' : 'pro_finished',
            stage2ndPass: false
          };
          
          if (selectedModel === 'nano2') {
            updateData.processedThumbnail = processedThumbnail;
          } else {
            updateData.finalThumbnail = processedThumbnail;
          }

          await updateDoc(doc(db, imagePath), updateData);
        } else {
          throw new Error(`No image returned from API`);
        }

      } catch (error: any) {
        console.error(`Error processing ${img.id}:`, error);
        await updateDoc(doc(db, imagePath), { status: 'error' });
      } finally {
        completedCount++;
        setProcessingProgress({ current: completedCount, total: targetImages.length });
      }
    };

    const workers = [];
    for (let i = 0; i < Math.min(CONCURRENCY_LIMIT, queue.length); i++) {
      workers.push((async () => {
        while (queue.length > 0) {
          const img = queue.shift();
          if (img) await processImage(img);
        }
      })());
    }

    await Promise.all(workers);
    setIsProcessing(false);
  };

  const [imageToDelete, setImageToDelete] = useState<string | null>(null);

  const deleteImage = async (imgId: string) => {
    try {
      await deleteDoc(doc(db, 'projects', projectId, 'images', imgId));
      await deleteHighResImage(`orig_${imgId}`);
      await deleteHighResImage(`proc_${imgId}`);
      await deleteHighResImage(`final_${imgId}`);
      setImageToDelete(null);
    } catch (error) {
      console.error('Error deleting image:', error);
      // Fallback alert is fine here since it's an error, but we should probably use a toast
    }
  };

  const [isDownloading, setIsDownloading] = useState(false);

  const downloadAll = async () => {
    const processedImages = images.filter(img => img.status === 'done' || img.status === 'final');
    if (processedImages.length === 0) return;

    setIsDownloading(true);
    try {
      const zip = new JSZip();
      
      for (const img of processedImages) {
        if (img.status === 'done' || img.status === 'final') {
          const procBase64 = await getHighResImage(`proc_${img.id}`);
          if (procBase64) {
            const jpgBase64 = await convertToJpg(procBase64);
            const data = jpgBase64.split(',')[1];
            zip.file(`property_${img.id}_nano2.jpg`, data, { base64: true });
          }
        }
        if (img.status === 'final') {
          const finalBase64 = await getHighResImage(`final_${img.id}`);
          if (finalBase64) {
            const jpgBase64 = await convertToJpg(finalBase64);
            const data = jpgBase64.split(',')[1];
            zip.file(`property_${img.id}_pro.jpg`, data, { base64: true });
          }
        }
      }
      
      const content = await zip.generateAsync({ type: 'blob' });
      saveAs(content, `${project?.name || 'project'}_images.zip`);
    } catch (error) {
      console.error('Error downloading images:', error);
      alert('Failed to download images.');
    } finally {
      setIsDownloading(false);
    }
  };

  const filteredImages = images.filter(img => {
    if (filter === 'all') return true;
    if (filter === 'redo') return img.flagForRedo;
    if (filter === '2ndPass') return img.stage2ndPass;
    if (filter === 'wtf') return img.wtf;
    return true;
  });

  const createBatchFromFiltered = async () => {
    if (!user || filteredImages.length === 0 || filter === 'all') return;
    setIsCreatingBatch(true);
    try {
      // 1. Create a new project
      const projectsPath = 'projects';
      let docRef;
      try {
        docRef = await addDoc(collection(db, projectsPath), {
          uid: user.uid,
          name: `${project?.name || 'Batch'} - ${filter.toUpperCase()} Reprocess`,
          address: project?.address || '',
          prompt: project?.prompt || '',
          createdAt: Date.now(),
        });
      } catch (error) {
        throw handleFirestoreError(error, 'create', projectsPath);
      }
      const newProjectId = docRef.id;

      // 2. Copy images
      for (const img of filteredImages) {
        let sourceHighResKey = `orig_${img.id}`;
        let sourceThumbnail = img.originalThumbnail;

        if (filter === '2ndPass' && img.processedThumbnail) {
          sourceHighResKey = `proc_${img.id}`;
          sourceThumbnail = img.processedThumbnail;
        }

        const highResBase64 = await getHighResImage(sourceHighResKey);
        if (!highResBase64) continue;

        const newImagesPath = `projects/${newProjectId}/images`;
        let newImgRef;
        try {
          newImgRef = await addDoc(collection(db, newImagesPath), {
            uid: user.uid,
            projectId: newProjectId,
            originalThumbnail: sourceThumbnail,
            status: 'pending',
            resolution: img.resolution || '',
            processingStage: 'analyzed',
            createdAt: Date.now(),
          });
        } catch (error) {
          throw handleFirestoreError(error, 'create', newImagesPath);
        }

        await storeHighResImage(`orig_${newImgRef.id}`, highResBase64);
      }

      // 3. Go back to dashboard so they can see the new batch
      onBack();
    } catch (error) {
      console.error('Error creating new batch:', error);
      alert('Failed to create new batch.');
    } finally {
      setIsCreatingBatch(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#2D3139] flex flex-col font-sans">
      <header className={`bg-[#2D3139] border-b border-white/5 sticky top-0 z-20 transition-all duration-300 ${isHeaderCollapsed ? 'h-12' : 'h-20'}`}>
        <div className="max-w-[1600px] mx-auto px-6 h-full flex items-center justify-between">
          <div className="flex items-center gap-6">
            <button 
              onClick={() => setIsHeaderCollapsed(!isHeaderCollapsed)}
              className="w-8 h-8 bg-[#3E434D] rounded-lg flex items-center justify-center hover:bg-[#4E535D] transition-colors"
            >
              <div className={`w-4 h-0.5 bg-white transition-transform ${isHeaderCollapsed ? '' : 'rotate-90'}`} />
              <div className="w-4 h-0.5 bg-white absolute" />
            </button>
            <div className={`flex items-center gap-4 transition-opacity ${isHeaderCollapsed ? 'opacity-0 pointer-events-none' : 'opacity-100'}`}>
              <div className="w-8 h-8 bg-[#D1604D] rounded-lg flex items-center justify-center shadow-lg shadow-black/20">
                <Sparkles className="w-5 h-5 text-white" />
              </div>
              <div>
                <h1 className="text-sm font-display font-bold tracking-tighter text-white uppercase leading-none">
                  WRIGHT CREATIVE&apos;S
                </h1>
                <p className="text-[8px] font-display font-medium tracking-[0.2em] text-[#A0A4AB] uppercase mt-0.5">
                  BATCH ENGINE
                </p>
              </div>
            </div>
          </div>

          {!isHeaderCollapsed && (
            <div className="flex items-center gap-8 animate-in fade-in duration-300">
              <div className="flex bg-[#3E434D] rounded-full p-1 border border-white/5">
                <button 
                  onClick={() => setTargetQueue('pending')}
                  className={`px-6 py-1.5 rounded-full text-[10px] font-display font-bold uppercase tracking-widest transition-all ${targetQueue === 'pending' ? 'bg-[#D1604D] text-white shadow-lg' : 'text-[#A0A4AB] hover:text-white'}`}
                >
                  BATCH
                </button>
                <button 
                  onClick={() => setTargetQueue('2ndPass')}
                  className={`px-6 py-1.5 rounded-full text-[10px] font-display font-bold uppercase tracking-widest transition-all ${targetQueue === '2ndPass' ? 'bg-[#D1604D] text-white shadow-lg' : 'text-[#A0A4AB] hover:text-white'}`}
                >
                  2ND PASS
                </button>
              </div>

              <div className="flex items-center gap-3">
                <button 
                  onClick={() => setRequestPriority(requestPriority === 'FLEX' ? 'BATCH' : 'FLEX')}
                  className={`flex items-center gap-2 bg-[#3E434D] rounded-xl px-4 py-2 border transition-all ${requestPriority === 'BATCH' ? 'border-emerald-500/50 shadow-lg shadow-emerald-500/10' : 'border-white/5 hover:border-white/20'}`}
                  title={requestPriority === 'BATCH' ? 'Batch Priority: Cheaper, but slower processing' : 'Flex Priority: Fastest processing, standard cost'}
                >
                  <span className={`text-[10px] font-display font-bold uppercase tracking-widest ${requestPriority === 'BATCH' ? 'text-emerald-400' : 'text-white'}`}>
                    {requestPriority === 'BATCH' ? 'BATCH SAVE' : 'FLEX PRO'}
                  </span>
                </button>
                <button 
                  onClick={() => setSelectedModel(selectedModel === 'nano2' ? 'pro' : 'nano2')}
                  className="flex items-center gap-2 bg-[#3E434D] rounded-xl px-4 py-2 border border-white/5 hover:border-white/20 transition-all"
                >
                  <span className="text-[10px] font-display font-bold text-white uppercase tracking-widest">
                    {selectedModel === 'nano2' ? '3.1 FLASH (HQ)' : '3 PRO (ULTRA)'}
                  </span>
                  <div className="w-2 h-2 border-r border-b border-white/40 rotate-45 mb-1" />
                </button>
                <div className="flex items-center gap-2 bg-[#3E434D] rounded-xl px-4 py-2 border border-white/5">
                  <span className="text-[10px] font-display font-bold text-white uppercase tracking-widest">
                    {selectedModel === 'nano2' ? '2K' : '4K'}
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-6">
                <div className="text-right">
                  <p className="text-[10px] font-display font-bold text-[#A0A4AB] uppercase tracking-widest">
                    {isProcessing ? 'PROCESSING' : 'EST. COST'}
                  </p>
                  <p className="text-xs font-display font-bold text-[#D1604D] uppercase tracking-widest">
                    {isProcessing ? `${processingProgress.current} / ${processingProgress.total}` : '0 TOKENS'}
                  </p>
                </div>
                <Button 
                  onClick={processBatch} 
                  disabled={isProcessing || isUploading || !prompt.trim() || images.length === 0 || (isSelectionMode && selectedImageIds.size === 0)}
                  className="bg-[#3E434D] hover:bg-[#4E535D] text-white font-display font-bold uppercase tracking-widest px-8 py-6 rounded-xl border border-white/5 disabled:opacity-50 min-w-[240px]"
                >
                  {isProcessing || isUploading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                  {isUploading 
                    ? 'UPLOADING...' 
                    : isProcessing 
                      ? 'PROCESSING...' 
                      : isSelectionMode && selectedImageIds.size > 0 
                        ? `PROCESS SELECTED (${selectedImageIds.size})`
                        : targetQueue === 'pending' 
                          ? (images.some(img => !img.analysis) ? 'ANALYZE & PROCESS' : 'PROCESS BATCH') 
                          : 'PROCESS 2nd PASS'}
                </Button>
              </div>
            </div>
          )}
          
          {isHeaderCollapsed && (
            <div className="flex items-center gap-4 animate-in fade-in duration-300">
              <span className="text-[10px] font-display font-bold text-[#A0A4AB] uppercase tracking-widest">
                {project?.name} | {isSelectionMode && selectedImageIds.size > 0 ? `${selectedImageIds.size} SELECTED` : `${images.length} IMAGES`}
              </span>
              <Button 
                onClick={processBatch} 
                disabled={isProcessing || !prompt.trim() || images.length === 0 || (isSelectionMode && selectedImageIds.size === 0)}
                size="sm"
                className="bg-[#D1604D] hover:bg-[#E1705D] text-white font-display font-bold uppercase tracking-widest px-4 py-1 rounded-lg text-[8px]"
              >
                {isSelectionMode && selectedImageIds.size > 0 ? `PROCESS (${selectedImageIds.size})` : 'PROCESS'}
              </Button>
            </div>
          )}
        </div>
      </header>

      <main className="flex-1 max-w-[1600px] w-full mx-auto px-6 py-12">
        {images.length === 0 ? (
          <div className="flex flex-col items-center justify-center min-h-[600px]">
            <div 
              {...getRootProps()} 
              className={`w-full max-w-4xl aspect-[2/1] rounded-[48px] border-2 border-dashed flex flex-col items-center justify-center transition-all duration-500 ${
                isDragActive ? 'border-[#D1604D] bg-[#D1604D]/5' : 'border-[#D1604D]/30 bg-[#3E434D]/20 hover:border-[#D1604D]/60 hover:bg-[#3E434D]/40'
              }`}
            >
              <input {...getInputProps()} />
              <div className="w-24 h-24 bg-[#3E434D] rounded-3xl flex items-center justify-center mb-8 shadow-2xl border border-white/5">
                <UploadCloud className="w-10 h-10 text-[#D1604D]" />
              </div>
              <h2 className="text-5xl font-display font-black text-white uppercase tracking-tight mb-4">
                DRAG IMAGES ANYWHERE
              </h2>
              <p className="text-lg font-display font-bold text-[#A0A4AB] uppercase tracking-[0.2em] mb-12">
                AND WE&apos;LL CATEGORIZE THEM AUTOMATICALLY
              </p>
              
              <div className="flex gap-4">
                {['INTERIOR', 'EXTERIOR', 'AERIAL', 'FURNITURE REMOVAL'].map((cat) => (
                  <button key={cat} className="px-8 py-3 rounded-2xl bg-[#3E434D] border border-white/10 text-[10px] font-display font-bold text-[#A0A4AB] uppercase tracking-widest hover:text-white hover:border-[#D1604D]/40 transition-all">
                    {cat}
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-12 gap-10">
            {/* Left Column: Grid */}
            <div className="col-span-9 space-y-8">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <Button 
                    variant={filter === 'all' ? 'default' : 'outline'} 
                    size="sm" 
                    onClick={() => setFilter('all')}
                    className={filter === 'all' ? 'bg-white text-black rounded-full px-6' : 'bg-[#3E434D] text-white border-white/5 rounded-full px-6'}
                  >
                    ALL ({images.length})
                  </Button>
                  <Button 
                    variant={filter === '2ndPass' ? 'default' : 'outline'} 
                    size="sm" 
                    onClick={() => setFilter('2ndPass')}
                    className={filter === '2ndPass' ? 'bg-[#D1604D] text-white rounded-full px-6' : 'bg-[#3E434D] text-white border-white/5 rounded-full px-6'}
                  >
                    2ND PASS ({images.filter(i => i.stage2ndPass).length})
                  </Button>
                  <Button 
                    variant={isSelectionMode ? 'default' : 'outline'} 
                    size="sm" 
                    onClick={() => {
                      setIsSelectionMode(!isSelectionMode);
                      if (isSelectionMode) setSelectedImageIds(new Set());
                    }}
                    className={isSelectionMode ? 'bg-[#D1604D] text-white rounded-full px-6' : 'bg-[#3E434D] text-white border-white/5 rounded-full px-6'}
                  >
                    {isSelectionMode ? 'CANCEL SELECTION' : 'SELECT IMAGES'}
                  </Button>
                  {isSelectionMode && (
                    <Button 
                      variant="outline" 
                      size="sm" 
                      onClick={selectAllImages}
                      className="bg-[#3E434D] text-white border-white/5 rounded-full px-6"
                    >
                      {selectedImageIds.size === filteredImages.length ? 'DESELECT ALL' : 'SELECT ALL'}
                    </Button>
                  )}
                </div>
                
                {filter !== 'all' && filteredImages.length > 0 && (
                  <Button 
                    size="sm" 
                    onClick={createBatchFromFiltered}
                    disabled={isCreatingBatch}
                    className="bg-[#D1604D] hover:bg-[#E1705D] text-white rounded-full px-8"
                  >
                    {isCreatingBatch ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Sparkles className="w-4 h-4 mr-2" />}
                    REPROCESS AS NEW BATCH
                  </Button>
                )}
              </div>

              <div className="grid grid-cols-3 gap-6">
                {filteredImages.map((img) => (
                  <div 
                    key={img.id} 
                    className={`bg-[#3E434D] rounded-[32px] border overflow-hidden shadow-2xl group cursor-pointer transition-all duration-300 ${
                      selectedImageIds.has(img.id) ? 'border-[#D1604D] ring-2 ring-[#D1604D]/20' : 'border-white/5'
                    }`}
                    onClick={() => {
                      if (isSelectionMode) {
                        toggleImageSelection(img.id);
                      } else {
                        setSelectedImage(img);
                      }
                    }}
                  >
                    <div className="relative aspect-[4/3] overflow-hidden">
                      <Image 
                        src={img.processedThumbnail || img.originalThumbnail} 
                        fill
                        className="object-cover transition-transform duration-700 group-hover:scale-110"
                        alt="" 
                        referrerPolicy="no-referrer"
                      />

                      {isSelectionMode && (
                        <div className="absolute top-4 right-4 z-10">
                          <div className={`w-8 h-8 rounded-xl flex items-center justify-center border-2 transition-all ${
                            selectedImageIds.has(img.id) 
                              ? 'bg-[#D1604D] border-[#D1604D]' 
                              : 'bg-black/40 border-white/20 backdrop-blur-md'
                          }`}>
                            {selectedImageIds.has(img.id) && <CheckCircle2 className="w-5 h-5 text-white" />}
                          </div>
                        </div>
                      )}

                      {(img.status === 'processing' || img.status === 'analyzing') && (
                        <div className="absolute inset-0 bg-black/40 backdrop-blur-[2px] flex flex-col items-center justify-center gap-3">
                          <Loader2 className="w-8 h-8 text-white animate-spin" />
                          <span className="text-[10px] font-display font-bold text-white uppercase tracking-widest">
                            {img.status === 'analyzing' ? 'Analyzing...' : 'Processing...'}
                          </span>
                        </div>
                      )}
                      
                      {/* Top Badges */}
                      <div className="absolute top-4 left-4 flex gap-2">
                        <div className="bg-[#2D3139]/80 backdrop-blur-md px-3 py-1 rounded-lg border border-white/10 text-[10px] font-display font-bold text-white uppercase tracking-widest">
                          {img.status === 'done' ? 'PROCESSED' : img.status === 'analyzing' ? 'ANALYZING' : img.status === 'processing' ? 'PROCESSING' : 'PENDING'}
                        </div>
                        <div className="bg-[#2D3139]/80 backdrop-blur-md px-3 py-1 rounded-lg border border-white/10 text-[10px] font-display font-bold text-[#4D94D1] uppercase tracking-widest">
                          {img.resolution || 'N/A'}
                        </div>
                      </div>

                      {!isSelectionMode && (
                        <button 
                          onClick={(e) => { e.stopPropagation(); setImageToDelete(img.id); }}
                          className="absolute top-4 right-4 w-10 h-10 bg-[#2D3139]/80 backdrop-blur-md rounded-full flex items-center justify-center border border-white/10 hover:bg-[#D1604D] transition-colors"
                        >
                          <Trash2 className="w-4 h-4 text-white" />
                        </button>
                      )}

                      {/* AI Suggestion Indicator */}
                      {img.analysis && (
                        <button 
                          onClick={(e) => { e.stopPropagation(); setSelectedImage(img); }}
                          className="absolute bottom-4 left-4 bg-[#D1604D] text-white text-[8px] font-display font-bold px-3 py-1.5 rounded-lg uppercase tracking-widest shadow-lg hover:bg-[#E1705D] transition-all"
                        >
                          VIEW ANALYSIS
                        </button>
                      )}
                    </div>

                    <div className="p-6 space-y-6">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-xs font-display font-bold text-[#A0A4AB] uppercase tracking-widest mb-1">DWD_{img.id.slice(0,4)}.JPG</p>
                        </div>
                        <div className="text-right">
                          <p className="text-[10px] font-display font-bold text-[#A0A4AB] uppercase tracking-widest">EST. 20</p>
                          <p className="text-[10px] font-display font-bold text-[#A0A4AB] uppercase tracking-widest">TOKENS</p>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Right Column: Actions */}
            <div className="col-span-3 space-y-6">
              <div className="bg-[#3E434D] rounded-[32px] border border-white/5 p-8 shadow-2xl">
                <h3 className="text-[10px] font-display font-bold text-[#A0A4AB] uppercase tracking-[0.2em] mb-8">BATCH ACTIONS</h3>
                
                <div className="space-y-4">
                  <button 
                    onClick={downloadAll} 
                    disabled={isDownloading}
                    className="w-full py-5 rounded-2xl bg-[#2D3139]/40 text-white text-xs font-display font-bold uppercase tracking-[0.2em] border border-white/5 hover:bg-[#2D3139]/60 transition-all flex items-center justify-center disabled:opacity-50"
                  >
                    {isDownloading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                    {isDownloading ? 'PREPARING...' : 'SAVE ALL RESULTS'}
                  </button>
                  <button className="w-full py-5 rounded-2xl bg-[#D1604D] text-white text-xs font-display font-bold uppercase tracking-[0.2em] shadow-xl shadow-[#D1604D]/20 hover:bg-[#E1705D] transition-all">
                    SAVE SELECTED ({isSelectionMode && selectedImageIds.size > 0 ? selectedImageIds.size : images.filter(img => img.status === 'done' || img.status === 'final').length})
                  </button>
                  {images.some(img => img.status === 'done' || img.status === 'final') && (
                    <>
                      <button className="w-full py-5 rounded-2xl bg-[#2D3139]/40 text-white text-xs font-display font-bold uppercase tracking-[0.2em] border border-white/5 hover:bg-[#2D3139]/60 transition-all">
                        STAGE FOR 2ND PASS
                      </button>
                      <button className="w-full py-5 rounded-2xl bg-[#2D3139]/40 text-white text-xs font-display font-bold uppercase tracking-[0.2em] border border-white/5 hover:bg-[#2D3139]/60 transition-all">
                        REPROCESS SELECTED
                      </button>
                    </>
                  )}
                  <button className="w-full py-5 rounded-2xl bg-[#2D3139]/40 text-white text-xs font-display font-bold uppercase tracking-[0.2em] border border-white/5 hover:bg-[#2D3139]/60 transition-all">
                    CLEAR UNSELECTED RESULTS
                  </button>
                </div>
              </div>

              {/* Prompt Settings */}
              <div className="bg-[#3E434D] rounded-[32px] border border-white/5 p-8 shadow-2xl">
                <div className="flex items-center justify-between mb-6">
                  <h3 className="text-[10px] font-display font-bold text-[#A0A4AB] uppercase tracking-[0.2em]">PROMPT SETTINGS</h3>
                  <div className="flex items-center gap-3">
                    <button 
                      onClick={analyzeAll} 
                      disabled={isAnalyzingAll || images.length === 0}
                      className="text-[#D1604D] hover:text-[#E1705D] transition-colors disabled:opacity-50 flex items-center gap-2"
                      title="Analyze all images to generate a batch prompt"
                    >
                      {isAnalyzingAll ? <Loader2 className="w-4 h-4 animate-spin" /> : <ImageIcon className="w-4 h-4" />}
                      <span className="text-[8px] font-display font-bold uppercase tracking-widest">ANALYZE</span>
                    </button>
                    {project?.address && (
                      <button 
                        onClick={generatePromptFromAddress} 
                        disabled={isGeneratingPrompt}
                        className="text-[#D1604D] hover:text-[#E1705D] transition-colors disabled:opacity-50"
                      >
                        {isGeneratingPrompt ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                      </button>
                    )}
                  </div>
                </div>
                
                <div className="relative mb-4">
                  <textarea
                    value={prompt}
                    onChange={(e) => savePrompt(e.target.value)}
                    placeholder="Enter beautification instructions..."
                    className="w-full h-48 bg-[#2D3139] border border-white/10 rounded-2xl p-4 text-sm font-display text-white placeholder-[#A0A4AB]/30 focus:outline-none focus:border-[#D1604D]/50 resize-none"
                  />
                  <div className="absolute bottom-4 right-4">
                    <VoicePrompt onPromptGenerated={savePrompt} />
                  </div>
                </div>

                <div className="space-y-4">
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={newPromptName}
                      onChange={(e) => setNewPromptName(e.target.value)}
                      placeholder="Name this prompt..."
                      className="flex-1 bg-[#2D3139] border border-white/10 rounded-xl px-4 py-2 text-xs font-display text-white placeholder-[#A0A4AB]/30 focus:outline-none focus:border-[#D1604D]/50"
                    />
                    <button
                      onClick={saveCurrentPrompt}
                      disabled={!prompt || !newPromptName || isSavingPrompt}
                      className="bg-[#D1604D] text-white text-[10px] font-display font-bold px-4 py-2 rounded-xl uppercase tracking-widest disabled:opacity-50"
                    >
                      SAVE
                    </button>
                  </div>

                  {savedPrompts.length > 0 && (
                    <div className="space-y-2">
                      <p className="text-[8px] font-display font-bold text-[#A0A4AB] uppercase tracking-widest">SAVED PROMPTS</p>
                      <div className="flex flex-wrap gap-2">
                        {savedPrompts.map((p, i) => (
                          <button
                            key={i}
                            onClick={() => loadPrompt(p.prompt)}
                            className="bg-[#2D3139] border border-white/5 hover:border-[#D1604D]/30 px-3 py-1.5 rounded-lg text-[10px] font-display font-bold text-white transition-all"
                          >
                            {p.name}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </main>

      {selectedImage && (
        <ImageModal 
          image={selectedImage} 
          projectId={projectId} 
          onClose={() => setSelectedImage(null)} 
          onNext={() => {
            const idx = filteredImages.findIndex(i => i.id === selectedImage.id);
            if (idx < filteredImages.length - 1) setSelectedImage(filteredImages[idx + 1]);
          }}
          onPrev={() => {
            const idx = filteredImages.findIndex(i => i.id === selectedImage.id);
            if (idx > 0) setSelectedImage(filteredImages[idx - 1]);
          }}
          hasNext={filteredImages.findIndex(i => i.id === selectedImage.id) < filteredImages.length - 1}
          hasPrev={filteredImages.findIndex(i => i.id === selectedImage.id) > 0}
        />
      )}

      <Dialog open={!!imageToDelete} onOpenChange={(open) => !open && setImageToDelete(null)}>
        <DialogContent className="bg-[#3E434D] border-white/5 text-white rounded-[32px]">
          <DialogHeader>
            <DialogTitle className="text-white font-display uppercase tracking-widest">Delete Image</DialogTitle>
            <DialogDescription className="text-[#A0A4AB] font-display">
              Are you sure you want to delete this image? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-4">
            <Button variant="outline" onClick={() => setImageToDelete(null)} className="bg-[#2D3139] border-white/5 text-[#A0A4AB] hover:text-white rounded-xl">Cancel</Button>
            <Button variant="destructive" onClick={() => imageToDelete && deleteImage(imageToDelete)} className="bg-[#D1604D] hover:bg-[#E1705D] text-white rounded-xl">Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {isCameraOpen && (
        <CameraCapture 
          onCapture={onDrop}
          onClose={() => setIsCameraOpen(false)}
        />
      )}
    </div>
  );
}
