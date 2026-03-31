'use client';

import { useState, useEffect, useCallback } from 'react';
import { useAuth } from './auth-provider';
import { db } from '@/lib/firebase';
import { doc, getDoc, updateDoc, collection, query, where, orderBy, onSnapshot, addDoc, deleteDoc } from 'firebase/firestore';
import { Button } from './ui/button';
import Image from 'next/image';
import { ArrowLeft, UploadCloud, Play, CheckCircle2, Loader2, Mic, Image as ImageIcon, Sparkles, Trash2, Download, Camera } from 'lucide-react';
import { useDropzone } from 'react-dropzone';
import { compressImage, fileToBase64, storeHighResImage, deleteHighResImage, getHighResImage, convertToJpg } from '@/lib/image-utils';
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

export default function ProjectView({ projectId, onBack }: ProjectViewProps) {
  const { user } = useAuth();
  const [project, setProject] = useState<any>(null);
  const [images, setImages] = useState<ProjectImage[]>([]);
  const [prompt, setPrompt] = useState('');
  const [selectedModel, setSelectedModel] = useState<'nano2' | 'pro'>('nano2');
  const [targetQueue, setTargetQueue] = useState<'pending' | '2ndPass'>('pending');
  const [isUploading, setIsUploading] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingProgress, setProcessingProgress] = useState({ current: 0, total: 0 });
  const [selectedImage, setSelectedImage] = useState<ProjectImage | null>(null);
  const [filter, setFilter] = useState<'all' | 'redo' | '2ndPass' | 'wtf'>('all');
  const [isCameraOpen, setIsCameraOpen] = useState(false);

  const [isGeneratingPrompt, setIsGeneratingPrompt] = useState(false);
  const [isAnalyzingAll, setIsAnalyzingAll] = useState(false);
  const [isCreatingBatch, setIsCreatingBatch] = useState(false);

  const handleFirestoreError = useCallback((error: any, operation: string, path: string) => {
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
        setProject({ id: docSnap.id, ...docSnap.data() });
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

  const generatePromptFromAddress = async () => {
    if (!project?.address) return;
    setIsGeneratingPrompt(true);
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.NEXT_PUBLIC_GEMINI_API_KEY });
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
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

  const analyzeAll = async () => {
    if (images.length === 0) return;
    setIsAnalyzingAll(true);
    
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.NEXT_PUBLIC_GEMINI_API_KEY });
      const allAnalyses: string[] = [];

      for (const img of images) {
        if (img.analysis) {
          allAnalyses.push(img.analysis);
          continue;
        }

        const imagePath = `projects/${projectId}/images/${img.id}`;
        try {
          await updateDoc(doc(db, imagePath), { status: 'analyzing' });
          
          const fullResBase64 = await getHighResImage(`orig_${img.id}`);
          if (!fullResBase64) continue;
          
          const mimeType = fullResBase64.split(';')[0].split(':')[1];
          const base64Data = fullResBase64.split(',')[1];

          const scanResponse = await ai.models.generateContent({
            model: 'gemini-3.1-flash-preview',
            contents: {
              parts: [
                {
                  inlineData: {
                    data: base64Data,
                    mimeType: mimeType,
                  },
                },
                {
                  text: "Briefly identify the specific technical flaws in this real estate photo that need beautification (e.g., lighting, sky color, lawn health, clarity, shadows). Be concise and technical.",
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
      }

      if (allAnalyses.length > 0) {
        // Generate a summary prompt for the entire batch
        const summaryResponse = await ai.models.generateContent({
          model: 'gemini-3.1-flash-preview',
          contents: `Based on the following technical analyses of a batch of real estate photos, create a single, cohesive, and effective beautification prompt for an AI image editor. The prompt should address the common issues found across the batch while maintaining architectural integrity and realism.

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
        // Full res for IndexedDB
        const fullRes = await fileToBase64(file);
        
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
      } catch (error: any) {
        console.error('Error uploading image:', error.message || error);
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
    
    const targetImages = images.filter(img => {
      if (targetQueue === 'pending') {
        return img.status === 'pending' || img.status === 'error';
      } else {
        return img.stage2ndPass;
      }
    });

    if (targetImages.length === 0) return;
    
    setIsProcessing(true);
    setProcessingProgress({ current: 0, total: targetImages.length });
    
    let current = 0;
    for (const img of targetImages) {
      const imagePath = `projects/${projectId}/images/${img.id}`;
      try {
        try {
          await updateDoc(doc(db, imagePath), { status: 'processing' });
        } catch (error) {
          throw handleFirestoreError(error, 'update', imagePath);
        }
        
        // Initialize Gemini
        const ai = new GoogleGenAI({ apiKey: process.env.NEXT_PUBLIC_GEMINI_API_KEY });
        
        // Get full res image from IndexedDB
        const { getHighResImage } = await import('@/lib/image-utils');
        const fullResBase64 = await getHighResImage(`orig_${img.id}`);
        
        if (!fullResBase64) throw new Error('Original image not found in local storage');
        
        const mimeType = fullResBase64.split(';')[0].split(':')[1];
        const base64Data = fullResBase64.split(',')[1];

        // 1. Pre-scan / Analysis Integration
        // If the image hasn't been analyzed yet, we perform a quick technical pre-scan
        // to identify specific flaws (lighting, lawn, sky) to improve generation aptitude.
        let currentAnalysis = img.analysis;
        if (!currentAnalysis) {
          try {
            const scanResponse = await ai.models.generateContent({
              model: 'gemini-3.1-flash-preview',
              contents: {
                parts: [
                  {
                    inlineData: {
                      data: base64Data,
                      mimeType: mimeType,
                    },
                  },
                  {
                    text: "Briefly identify the specific technical flaws in this real estate photo that need beautification (e.g., lighting, sky color, lawn health, clarity, shadows). Be concise and technical.",
                  },
                ],
              },
            });
            currentAnalysis = scanResponse.text;
            // Save analysis back to Firestore so the user can see it in the modal later
            await updateDoc(doc(db, imagePath), { analysis: currentAnalysis });
          } catch (scanError) {
            console.warn(`Pre-scan failed for image ${img.id}, proceeding with general prompt:`, scanError);
          }
        }

        // 2. Process with selected model
        const modelName = selectedModel === 'nano2' ? 'gemini-3.1-flash-image-preview' : 'gemini-3-pro-image-preview';
        const imageSize = selectedModel === 'nano2' ? '2K' : '4K';

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
                text: `Enhance this real estate photo. Make it look professional and beautiful. 
                
                IMPORTANT CONSTRAINTS:
                - Maintain the EXACT architectural structure and scene layout.
                - Do NOT add fictional elements (no new furniture, people, or cars).
                - Focus strictly on refinements to lighting, sky, and landscaping.
                - Ensure the color balance remains natural and realistic.
                
                SPECIFIC IMAGE ANALYSIS TO ADDRESS:
                ${currentAnalysis || 'General beautification required.'}
                
                USER BATCH INSTRUCTIONS:
                ${prompt}`,
              },
            ],
          },
          config: {
            imageConfig: {
              aspectRatio: "16:9",
              imageSize: imageSize
            }
          }
        });

        let processedBase64 = '';
        let responseText = '';
        const candidate = response.candidates?.[0];
        
        if (candidate) {
          if (candidate.finishReason && candidate.finishReason !== 'STOP') {
            throw new Error(`Generation failed with reason: ${candidate.finishReason}`);
          }
          for (const part of candidate.content?.parts || []) {
            if (part.inlineData) {
              processedBase64 = `data:image/png;base64,${part.inlineData.data}`;
              break;
            } else if (part.text) {
              responseText += part.text;
            }
          }
        }

        if (processedBase64) {
          // Store high res processed image
          const highResKey = selectedModel === 'nano2' ? `proc_${img.id}` : `final_${img.id}`;
          await storeHighResImage(highResKey, processedBase64);
          
          // Create thumbnail for Firestore
          const res = await fetch(processedBase64);
          const blob = await res.blob();
          const file = new File([blob], 'processed.png', { type: 'image/jpg' });
          const processedThumbnail = await compressImage(file, 400, 400, 0.6);

          const updateData: any = {
            status: 'done',
            processingStage: selectedModel === 'nano2' ? 'nano2_finished' : 'pro_finished',
          };
          
          if (selectedModel === 'nano2') {
            updateData.processedThumbnail = processedThumbnail;
          } else {
            updateData.finalThumbnail = processedThumbnail;
            updateData.status = 'final';
          }

          // If it was a 2nd pass, clear the flag
          if (targetQueue === '2ndPass') {
            updateData.stage2ndPass = false;
          }

          try {
            await updateDoc(doc(db, imagePath), updateData);
          } catch (error) {
            throw handleFirestoreError(error, 'update', imagePath);
          }
        } else {
          console.error("API Response Text:", responseText);
          console.error("API Response:", JSON.stringify(response));
          throw new Error(`No image returned from API. Response: ${responseText}`);
        }

      } catch (error: any) {
        console.error(`Error processing image ${img.id}:`, error.message || error);
        try {
          await updateDoc(doc(db, imagePath), { status: 'error' });
        } catch (updateError) {
          handleFirestoreError(updateError, 'update', imagePath);
        }
      } finally {
        current++;
        setProcessingProgress({ current, total: targetImages.length });
      }
    }
    
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
        let resolution = img.resolution || '';

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
            resolution,
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
      <header className="bg-[#2D3139] border-b border-white/5 sticky top-0 z-20">
        <div className="max-w-[1600px] mx-auto px-6 h-20 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <div className="w-10 h-10 bg-[#D1604D] rounded-xl flex items-center justify-center shadow-lg shadow-black/20">
              <Sparkles className="w-6 h-6 text-white" />
            </div>
            <div>
              <h1 className="text-lg font-display font-bold tracking-tighter text-white uppercase leading-none">
                WRIGHT CREATIVE&apos;S
              </h1>
              <p className="text-[10px] font-display font-medium tracking-[0.2em] text-[#A0A4AB] uppercase mt-1">
                BATCH ENHANCEMENT ENGINE
              </p>
            </div>
          </div>

          <div className="flex items-center gap-8">
            <div className="flex bg-[#3E434D] rounded-full p-1 border border-white/5">
              <button className="px-6 py-1.5 rounded-full bg-[#D1604D] text-white text-[10px] font-display font-bold uppercase tracking-widest shadow-lg">
                PHOTO
              </button>
              <button className="px-6 py-1.5 rounded-full text-[#A0A4AB] text-[10px] font-display font-bold uppercase tracking-widest hover:text-white transition-colors">
                VIDEO
              </button>
            </div>

            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2 bg-[#3E434D] rounded-xl px-4 py-2 border border-white/5">
                <span className="text-[10px] font-display font-bold text-white uppercase tracking-widest">3.1 FLASH (HQ)</span>
                <div className="w-2 h-2 border-r border-b border-white/40 rotate-45 mb-1" />
              </div>
              <div className="flex items-center gap-2 bg-[#3E434D] rounded-xl px-4 py-2 border border-white/5">
                <span className="text-[10px] font-display font-bold text-white uppercase tracking-widest">4K</span>
                <div className="w-2 h-2 border-r border-b border-white/40 rotate-45 mb-1" />
              </div>
            </div>

            <div className="flex items-center gap-6">
              <div className="text-right">
                <p className="text-[10px] font-display font-bold text-[#A0A4AB] uppercase tracking-widest">EST. COST</p>
                <p className="text-xs font-display font-bold text-[#D1604D] uppercase tracking-widest">0 TOKENS</p>
              </div>
              <Button 
                onClick={processBatch} 
                disabled={isProcessing || !prompt.trim() || images.length === 0}
                className="bg-[#3E434D] hover:bg-[#4E535D] text-[#A0A4AB] font-display font-bold uppercase tracking-widest px-8 py-6 rounded-xl border border-white/5 disabled:opacity-50"
              >
                {isProcessing ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                {targetQueue === 'pending' ? 'PROCESS BATCH' : 'PROCESS 2nd PASS'}
              </Button>
            </div>
          </div>
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
                    className={filter === 'all' ? 'bg-white text-black rounded-full px-6' : 'bg-[#3E434D] text-[#A0A4AB] border-white/5 rounded-full px-6'}
                  >
                    ALL ({images.length})
                  </Button>
                  <Button 
                    variant={filter === '2ndPass' ? 'default' : 'outline'} 
                    size="sm" 
                    onClick={() => setFilter('2ndPass')}
                    className={filter === '2ndPass' ? 'bg-[#D1604D] text-white rounded-full px-6' : 'bg-[#3E434D] text-[#A0A4AB] border-white/5 rounded-full px-6'}
                  >
                    2ND PASS ({images.filter(i => i.stage2ndPass).length})
                  </Button>
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
                    className="bg-[#3E434D] rounded-[32px] border border-white/5 overflow-hidden shadow-2xl group cursor-pointer"
                    onClick={() => setSelectedImage(img)}
                  >
                    <div className="relative aspect-[4/3] overflow-hidden">
                      <Image 
                        src={img.processedThumbnail || img.originalThumbnail} 
                        fill
                        className="object-cover transition-transform duration-700 group-hover:scale-110"
                        alt="" 
                        referrerPolicy="no-referrer"
                      />

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

                      <button 
                        onClick={(e) => { e.stopPropagation(); setImageToDelete(img.id); }}
                        className="absolute top-4 right-4 w-10 h-10 bg-[#2D3139]/80 backdrop-blur-md rounded-full flex items-center justify-center border border-white/10 hover:bg-[#D1604D] transition-colors"
                      >
                        <Trash2 className="w-4 h-4 text-white" />
                      </button>

                      {/* AI Suggestion Overlay */}
                      {img.analysis && (
                        <div className="absolute bottom-4 left-4 right-4 bg-[#2D3139]/90 backdrop-blur-xl p-4 rounded-2xl border border-[#D1604D]/30 shadow-2xl">
                          <div className="flex items-center justify-between mb-2">
                            <span className="text-[10px] font-display font-bold text-[#D1604D] uppercase tracking-widest">AI SUGGESTION:</span>
                            <button className="bg-[#D1604D] text-white text-[8px] font-display font-bold px-3 py-1 rounded-md uppercase tracking-widest">APPLY</button>
                          </div>
                          <p className="text-xs font-display italic text-[#A0A4AB] leading-relaxed">
                            &quot;{img.analysis.slice(0, 80)}...&quot;
                          </p>
                        </div>
                      )}
                    </div>

                    <div className="p-6 space-y-6">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-xs font-display font-bold text-[#A0A4AB] uppercase tracking-widest mb-1">DWD_{img.id.slice(0,4)}.JPG</p>
                          <div className="flex bg-[#2D3139] rounded-lg p-1 border border-white/5">
                            <button className="px-4 py-1 rounded-md bg-[#D1604D] text-white text-[8px] font-display font-bold uppercase tracking-widest">PHOTO</button>
                            <button className="px-4 py-1 rounded-md text-[#A0A4AB] text-[8px] font-display font-bold uppercase tracking-widest">VIDEO</button>
                          </div>
                        </div>
                        <div className="text-right">
                          <p className="text-[10px] font-display font-bold text-[#A0A4AB] uppercase tracking-widest">EST. 20</p>
                          <p className="text-[10px] font-display font-bold text-[#A0A4AB] uppercase tracking-widest">TOKENS</p>
                        </div>
                      </div>

                      <div>
                        <p className="text-[10px] font-display font-bold text-[#A0A4AB] uppercase tracking-widest mb-3">CATEGORY</p>
                        <div className="relative">
                          <select className="w-full bg-[#2D3139] border border-white/10 rounded-xl px-4 py-3 text-xs font-display font-bold text-white appearance-none focus:outline-none focus:border-[#D1604D]/50">
                            <option>Interior</option>
                            <option>Exterior</option>
                            <option>Aerial</option>
                          </select>
                          <div className="absolute right-4 top-1/2 -translate-y-1/2 w-2 h-2 border-r border-b border-white/40 rotate-45" />
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
                  <button onClick={downloadAll} className="w-full py-5 rounded-2xl bg-[#2D3139]/40 text-[#A0A4AB] text-xs font-display font-bold uppercase tracking-[0.2em] border border-white/5 hover:bg-[#2D3139]/60 transition-all">
                    SAVE ALL RESULTS
                  </button>
                  <button className="w-full py-5 rounded-2xl bg-[#D1604D] text-white text-xs font-display font-bold uppercase tracking-[0.2em] shadow-xl shadow-[#D1604D]/20 hover:bg-[#E1705D] transition-all">
                    SAVE SELECTED (0)
                  </button>
                  <button className="w-full py-5 rounded-2xl bg-[#2D3139]/40 text-[#D1604D]/40 text-xs font-display font-bold uppercase tracking-[0.2em] border border-white/5">
                    STAGE FOR 2ND PASS (0)
                  </button>
                  <button className="w-full py-5 rounded-2xl bg-[#2D3139]/40 text-[#D1604D]/40 text-xs font-display font-bold uppercase tracking-[0.2em] border border-white/5">
                    REPROCESS SELECTED (0)
                  </button>
                  <button className="w-full py-5 rounded-2xl bg-[#2D3139]/40 text-[#A0A4AB] text-xs font-display font-bold uppercase tracking-[0.2em] border border-white/5 hover:bg-[#2D3139]/60 transition-all">
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
                      <span className="text-[8px] font-display font-bold uppercase tracking-widest">ANALYZE ALL</span>
                    </button>
                    {project?.address && (
                      <button onClick={generatePromptFromAddress} className="text-[#D1604D] hover:text-[#E1705D] transition-colors">
                        <Sparkles className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                </div>
                
                <div className="relative">
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
