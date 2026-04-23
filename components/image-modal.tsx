'use client';

import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import Image from 'next/image';
import { Button } from '@/components/ui/button';
import { Loader2, Sparkles, ScanSearch, ChevronLeft, ChevronRight, Download, Trash2 } from 'lucide-react';
import { getHighResImage, storeHighResImage, compressImage, deleteHighResImage, convertToJpg, applyOverlayToDataUrl, downloadUrl } from '@/lib/image-utils';
import { doc, updateDoc, deleteDoc } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { GoogleGenAI } from '@google/genai';
import Markdown from 'react-markdown';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Layers } from 'lucide-react';

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

interface ImageModalProps {
  image: ProjectImage;
  projectId: string;
  onClose: () => void;
  onNext?: () => void;
  onPrev?: () => void;
  hasNext?: boolean;
  hasPrev?: boolean;
}

export default function ImageModal({ image, projectId, onClose, onNext, onPrev, hasNext, hasPrev }: ImageModalProps) {
  const [originalUrl, setOriginalUrl] = useState<string>('');
  const [processedUrl, setProcessedUrl] = useState<string>('');
  const [finalUrl, setFinalUrl] = useState<string>('');
  const [isGeneratingPro, setIsGeneratingPro] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysis, setAnalysis] = useState<string>(image?.analysis || '');
  const [showAnalysis, setShowAnalysis] = useState(true);
  const [viewMode, setViewMode] = useState<'original' | 'processed' | 'final' | 'analysis'>('processed');
  const [isApplyingOverlay, setIsApplyingOverlay] = useState(false);
  
  // Review Flags
  const [flagForRedo, setFlagForRedo] = useState<boolean>(image?.flagForRedo || false);
  const [stage2ndPass, setStage2ndPass] = useState<boolean>(image?.stage2ndPass || false);
  const [wtf, setWtf] = useState<boolean>(image?.wtf || false);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' && hasNext && onNext) onNext();
      if (e.key === 'ArrowLeft' && hasPrev && onPrev) onPrev();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [hasNext, hasPrev, onNext, onPrev]);

  useEffect(() => {
    if (!image) return;
    
    setFlagForRedo(image.flagForRedo || false);
    setStage2ndPass(image.stage2ndPass || false);
    setWtf(image.wtf || false);
    setAnalysis(image.analysis || '');
    
    // Reset URLs when image changes
    setOriginalUrl('');
    setProcessedUrl('');
    setFinalUrl('');
    
    const loadImages = async () => {
      const orig = await getHighResImage(`orig_${image.id}`);
      if (orig) setOriginalUrl(orig);
      
      if (image.status === 'done' || image.status === 'final') {
        const proc = await getHighResImage(`proc_${image.id}`);
        if (proc) setProcessedUrl(proc);
      }
      
      if (image.finalThumbnail) {
        const final = await getHighResImage(`final_${image.id}`);
        if (final) {
          setFinalUrl(final);
          setViewMode('final');
        }
      } else if (image.status === 'done') {
        setViewMode('processed');
      } else {
        setViewMode('original');
      }
    };
    
    loadImages();
  }, [image]);

  const toggleFlag = async (flagName: 'flagForRedo' | 'stage2ndPass' | 'wtf', currentValue: boolean) => {
    const newValue = !currentValue;
    
    if (flagName === 'flagForRedo') setFlagForRedo(newValue);
    if (flagName === 'stage2ndPass') setStage2ndPass(newValue);
    if (flagName === 'wtf') setWtf(newValue);
    
    try {
      await updateDoc(doc(db, 'projects', projectId, 'images', image.id), {
        [flagName]: newValue
      });
    } catch (error) {
      console.error(`Error updating ${flagName}:`, error);
      // Revert on error
      if (flagName === 'flagForRedo') setFlagForRedo(currentValue);
      if (flagName === 'stage2ndPass') setStage2ndPass(currentValue);
      if (flagName === 'wtf') setWtf(currentValue);
    }
  };

  const analyzeImage = async () => {
    if (!originalUrl) return;
    setIsAnalyzing(true);
    
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.NEXT_PUBLIC_GEMINI_API_KEY });
      
      const mimeType = originalUrl.split(';')[0].split(':')[1];
      const base64Data = originalUrl.split(',')[1];

      const response = await ai.models.generateContent({
        model: 'gemini-3.1-pro-preview',
        contents: {
          parts: [
            {
              inlineData: {
                data: base64Data,
                mimeType: mimeType,
              },
            },
            {
              text: "Analyze this real estate photo like a professional photo editor. Return a list of 'Lightroom Classic' style adjustments in bullet points (e.g., Exposure, Contrast, Highlights, Shadows, Whites, Blacks, Saturation, Vibrance, Clarity). Then, provide a single 'Suggested Beautification Prompt' that summarizes these changes for an AI image generator. Be concise.",
            },
          ],
        }
      });

      const resultText = response.text || 'No analysis generated.';
      setAnalysis(resultText);
      
      await updateDoc(doc(db, 'projects', projectId, 'images', image.id), {
        analysis: resultText
      });
      
    } catch (error) {
      console.error('Error analyzing image:', error);
      setAnalysis('Error analyzing image. Please try again.');
    } finally {
      setIsAnalyzing(false);
    }
  };

  const generateProVersion = async () => {
    if (!processedUrl) return;
    setIsGeneratingPro(true);
    
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.NEXT_PUBLIC_GEMINI_API_KEY });
      
      const mimeType = processedUrl.split(';')[0].split(':')[1];
      const base64Data = processedUrl.split(',')[1];

      // Use Nano Banana Pro (gemini-3-pro-image-preview)
      const response = await ai.models.generateContent({
        model: 'gemini-3-pro-image-preview',
        contents: {
          parts: [
            {
              inlineData: {
                data: base64Data,
                mimeType: mimeType,
              },
            },
            {
              text: `Enhance this real estate photo to professional grade post-production quality. 
              
              IMPORTANT CONSTRAINTS:
              - Maintain the EXACT architectural structure, scene layout, and environment.
              - Do NOT add fictional outdoor elements or change the topography or secondary structures in background. 
              - Focus strictly on subtle refinements to lighting, texture, clarity, and detail.
              - Ensure the color balance remains neutral and natural, avoiding any artificial color tints or casts.
              
              SPECIFIC IMAGE ANALYSIS TO ADDRESS:
              ${analysis || 'General professional enhancement required.'}`,
            },
          ],
        },
        config: {
          imageConfig: {
            aspectRatio: "16:9",
            imageSize: "4K"
          }
        }
      });

      let finalBase64 = '';
      let responseText = '';
      for (const part of response.candidates?.[0]?.content?.parts || []) {
        if (part.inlineData) {
          finalBase64 = `data:image/png;base64,${part.inlineData.data}`;
          break;
        } else if (part.text) {
          responseText += part.text;
        }
      }

      if (finalBase64) {
        await storeHighResImage(`final_${image.id}`, finalBase64);
        setFinalUrl(finalBase64);
        setViewMode('final');
        
        // Create thumbnail for Firestore
        const res = await fetch(finalBase64);
        const blob = await res.blob();
        const file = new File([blob], 'final.png', { type: 'image/png' });
        const finalThumbnail = await compressImage(file, 400, 400, 0.6);

        await updateDoc(doc(db, 'projects', projectId, 'images', image.id), {
          finalThumbnail,
          status: 'final',
          processingStage: 'pro_finished'
        });
      } else {
        console.error("API Response Text:", responseText);
        console.error("API Response:", JSON.stringify(response));
        throw new Error(`No image returned from API. Response: ${responseText}`);
      }
    } catch (error) {
      console.error('Error generating pro version:', error);
    } finally {
      setIsGeneratingPro(false);
    }
  };

  const currentImageUrl = 
    viewMode === 'final' ? finalUrl : 
    viewMode === 'processed' ? processedUrl : 
    originalUrl;

  const handleDownload = async () => {
    if (!currentImageUrl) return;
    const jpgDataUrl = await convertToJpg(currentImageUrl);
    await downloadUrl(jpgDataUrl, `property_${image.id}_${viewMode}.jpg`);
  };

  const applyOverlay = async (type: string) => {
    if (!currentImageUrl) return;
    setIsApplyingOverlay(true);
    try {
      const overlaidDataUrl = await applyOverlayToDataUrl(currentImageUrl, type);
      
      // We can either just download it, or save it as the final version
      // Let's save it as the final version if it's the final/processed image
      if (viewMode === 'final' || viewMode === 'processed') {
        await storeHighResImage(`final_${image.id}`, overlaidDataUrl);
        setFinalUrl(overlaidDataUrl);
        setViewMode('final');
        
        // Update thumbnail
        const res = await fetch(overlaidDataUrl);
        const blob = await res.blob();
        const file = new File([blob], 'final_with_overlay.jpg', { type: 'image/jpeg' });
        const finalThumbnail = await compressImage(file, 400, 400, 0.6);

        await updateDoc(doc(db, 'projects', projectId, 'images', image.id), {
          finalThumbnail,
          status: 'final',
          processingStage: 'overlay_applied'
        });
      } else {
        // If it's original, maybe just download it? 
        // For now, let's treat it as a "save to final" if user wants an overlay.
        await downloadUrl(overlaidDataUrl, `property_${image.id}_overlay.jpg`);
      }
    } catch (error) {
      console.error('Error applying overlay:', error);
    } finally {
      setIsApplyingOverlay(false);
    }
  };

  const [isDeleting, setIsDeleting] = useState(false);

  const handleDelete = async () => {
    try {
      await deleteDoc(doc(db, 'projects', projectId, 'images', image.id));
      await deleteHighResImage(`orig_${image.id}`);
      await deleteHighResImage(`proc_${image.id}`);
      await deleteHighResImage(`final_${image.id}`);
      onClose();
    } catch (error) {
      console.error('Error deleting image:', error);
    }
  };

  return (
    <Dialog open={!!image} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-5xl w-full h-[90vh] flex flex-col p-0 overflow-hidden bg-zinc-950 border-zinc-800">
        <DialogHeader className="p-4 border-b border-zinc-800 bg-zinc-900 flex flex-row items-center justify-between">
          <DialogTitle className="text-zinc-100">Image Details</DialogTitle>
          
          <div className="flex items-center gap-2">
            <div className="flex bg-zinc-800 rounded-lg p-1">
              <button
                onClick={() => setViewMode('original')}
                className={`px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest rounded-md transition-colors ${viewMode === 'original' ? 'bg-zinc-700 text-white' : 'text-zinc-300 hover:text-zinc-100'}`}
              >
                ORIGINAL
              </button>
              <button
                onClick={() => setViewMode('processed')}
                disabled={!processedUrl}
                className={`px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest rounded-md transition-colors ${viewMode === 'processed' ? 'bg-zinc-700 text-white' : 'text-zinc-300 hover:text-zinc-100'} disabled:opacity-50`}
              >
                NANO 2
              </button>
              <button
                onClick={() => setViewMode('final')}
                disabled={!finalUrl}
                className={`px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest rounded-md transition-colors ${viewMode === 'final' ? 'bg-indigo-600 text-white' : 'text-zinc-300 hover:text-zinc-100'} disabled:opacity-50`}
              >
                PRO
              </button>
            </div>
            
            {viewMode === 'original' && (
              <Button 
                onClick={analyzeImage} 
                disabled={isAnalyzing}
                variant="outline"
                className="bg-zinc-800 text-white border-zinc-700 hover:bg-zinc-700 hover:text-white ml-4 text-[10px] font-bold uppercase tracking-widest"
              >
                {isAnalyzing ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <ScanSearch className="w-4 h-4 mr-2" />}
                ANALYZE
              </Button>
            )}

            {!finalUrl && processedUrl && viewMode === 'processed' && (
              <Button 
                onClick={generateProVersion} 
                disabled={isGeneratingPro}
                className="bg-indigo-600 hover:bg-indigo-700 text-white ml-2 text-[10px] font-bold uppercase tracking-widest"
              >
                {isGeneratingPro ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Sparkles className="w-4 h-4 mr-2" />}
                GENERATE PRO
              </Button>
            )}

            {processedUrl && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button 
                    variant="outline" 
                    size="icon" 
                    disabled={isApplyingOverlay}
                    className="bg-zinc-800 text-zinc-200 border-zinc-700 hover:bg-zinc-700 hover:text-white ml-2" 
                    title="Apply Overlay"
                  >
                    {isApplyingOverlay ? <Loader2 className="w-4 h-4 animate-spin" /> : <Layers className="w-4 h-4" />}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent className="bg-zinc-900 border-zinc-700 text-zinc-100">
                  <DropdownMenuItem onClick={() => applyOverlay('digitally_enhanced')} className="hover:bg-zinc-800 cursor-pointer">
                    Digitally Enhanced
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => applyOverlay('virtually_staged')} className="hover:bg-zinc-800 cursor-pointer">
                    Virtually Staged
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => applyOverlay('digitally_decluttered')} className="hover:bg-zinc-800 cursor-pointer">
                    Digitally Decluttered
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}

            <Button 
              onClick={handleDownload} 
              variant="outline" 
              size="icon" 
              className="bg-zinc-800 text-zinc-200 border-zinc-700 hover:bg-zinc-700 hover:text-white ml-2" 
              title="Download Image"
            >
              <Download className="w-4 h-4" />
            </Button>

            <Button 
              onClick={() => setIsDeleting(true)} 
              variant="outline" 
              size="icon" 
              className="bg-zinc-800 text-red-400 border-zinc-700 hover:bg-red-500 hover:text-white hover:border-red-500 ml-2" 
              title="Delete Image"
            >
              <Trash2 className="w-4 h-4" />
            </Button>
          </div>
        </DialogHeader>
        
        <div className="flex-1 relative bg-zinc-950 flex items-center justify-center p-4 overflow-hidden group">
          {analysis && viewMode === 'original' && showAnalysis && (
            <div className="absolute top-4 left-4 right-4 z-20 bg-black/80 backdrop-blur-md p-6 rounded-xl border border-white/10 max-h-[40%] overflow-y-auto shadow-2xl">
              <div className="flex items-center justify-between mb-4">
                <p className="text-[10px] font-bold text-indigo-400 uppercase tracking-widest">AI EDITING ANALYSIS (LIGHTROOM STYLE)</p>
                <button 
                  onClick={() => setShowAnalysis(false)}
                  className="text-zinc-500 hover:text-white transition-colors"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
              <div className="text-sm text-zinc-200 leading-relaxed prose prose-invert prose-sm max-w-none">
                <Markdown>{analysis}</Markdown>
              </div>
            </div>
          )}
          {!showAnalysis && analysis && viewMode === 'original' && (
            <button 
              onClick={() => setShowAnalysis(true)}
              className="absolute top-4 right-4 z-20 bg-black/60 backdrop-blur-md p-2 rounded-lg border border-white/10 text-xs font-bold text-indigo-400 uppercase tracking-widest hover:bg-black/80 transition-all"
            >
              SHOW ANALYSIS
            </button>
          )}
          {hasPrev && (
            <Button 
              variant="ghost" 
              size="icon" 
              className="absolute left-4 z-10 bg-black/50 text-white hover:bg-black/70 rounded-full h-12 w-12 opacity-0 group-hover:opacity-100 transition-opacity" 
              onClick={onPrev}
            >
              <ChevronLeft className="w-8 h-8" />
            </Button>
          )}
          {viewMode === 'analysis' ? (
            <div className="w-full h-full flex flex-col md:flex-row gap-6 overflow-hidden">
              <div className="flex-1 flex items-center justify-center bg-zinc-900 rounded-xl p-4 relative min-h-[300px]">
                {originalUrl && (
                  <Image 
                    src={originalUrl} 
                    fill 
                    className="object-contain rounded-lg" 
                    alt="Original" 
                    referrerPolicy="no-referrer"
                  />
                )}
              </div>
              <div className="flex-1 bg-zinc-900 rounded-xl p-6 overflow-y-auto text-zinc-300">
                <h3 className="text-xl font-semibold text-white mb-4 flex items-center">
                  <ScanSearch className="w-5 h-5 mr-2 text-indigo-400" />
                  Image Analysis
                </h3>
                {isAnalyzing ? (
                  <div className="flex flex-col items-center justify-center h-64 text-zinc-500">
                    <Loader2 className="w-8 h-8 animate-spin mb-4 text-indigo-500" />
                    <p>Analyzing architectural style, landscaping, and lighting...</p>
                  </div>
                ) : analysis ? (
                  <div className="prose prose-invert prose-sm max-w-none">
                    <Markdown>{analysis}</Markdown>
                  </div>
                ) : (
                  <div className="flex flex-col items-center justify-center h-64 text-zinc-500">
                    <p className="mb-4 text-center">No analysis available yet.</p>
                    <Button onClick={analyzeImage} className="bg-indigo-600 hover:bg-indigo-700 text-white">
                      Analyze Now
                    </Button>
                  </div>
                )}
              </div>
            </div>
          ) : currentImageUrl ? (
            <div className="relative w-full h-full">
              <Image 
                src={currentImageUrl} 
                fill
                className="object-contain rounded-lg shadow-2xl"
                alt="Real Estate" 
                referrerPolicy="no-referrer"
              />
            </div>
          ) : (
            <div className="flex flex-col items-center text-zinc-500">
              <Loader2 className="w-8 h-8 animate-spin mb-4" />
              <p>Loading high-res image...</p>
            </div>
          )}
          
          {hasNext && (
            <Button 
              variant="ghost" 
              size="icon" 
              className="absolute right-4 z-10 bg-black/50 text-white hover:bg-black/70 rounded-full h-12 w-12 opacity-0 group-hover:opacity-100 transition-opacity" 
              onClick={onNext}
            >
              <ChevronRight className="w-8 h-8" />
            </Button>
          )}
        </div>
        
        <DialogFooter className="p-4 border-t border-zinc-800 bg-zinc-900 flex flex-row items-center justify-start sm:justify-start gap-6">
          <label className="flex items-center gap-2 text-[10px] font-bold text-zinc-300 cursor-pointer hover:text-white transition-colors uppercase tracking-widest">
            <input 
              type="checkbox" 
              checked={flagForRedo} 
              onChange={() => toggleFlag('flagForRedo', flagForRedo)}
              className="w-4 h-4 rounded border-zinc-700 bg-zinc-800 text-indigo-600 focus:ring-indigo-600 focus:ring-offset-zinc-900"
            />
            FLAG FOR REDO
          </label>
          <label className="flex items-center gap-2 text-[10px] font-bold text-zinc-300 cursor-pointer hover:text-white transition-colors uppercase tracking-widest">
            <input 
              type="checkbox" 
              checked={stage2ndPass} 
              onChange={() => toggleFlag('stage2ndPass', stage2ndPass)}
              className="w-4 h-4 rounded border-zinc-700 bg-zinc-800 text-indigo-600 focus:ring-indigo-600 focus:ring-offset-zinc-900"
            />
            STAGE 2ND PASS
          </label>
          <label className="flex items-center gap-2 text-[10px] font-bold text-zinc-300 cursor-pointer hover:text-white transition-colors uppercase tracking-widest">
            <input 
              type="checkbox" 
              checked={wtf} 
              onChange={() => toggleFlag('wtf', wtf)}
              className="w-4 h-4 rounded border-zinc-700 bg-zinc-800 text-red-500 focus:ring-red-500 focus:ring-offset-zinc-900"
            />
            WTF!
          </label>
        </DialogFooter>
      </DialogContent>

      <Dialog open={isDeleting} onOpenChange={setIsDeleting}>
        <DialogContent className="bg-zinc-900 border-zinc-800 text-zinc-100">
          <DialogHeader>
            <DialogTitle className="text-zinc-100">Delete Image</DialogTitle>
            <DialogDescription className="text-zinc-400">
              Are you sure you want to delete this image? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsDeleting(false)} className="border-zinc-700 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100">Cancel</Button>
            <Button variant="destructive" onClick={handleDelete} className="bg-red-600 hover:bg-red-700 text-white">Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Dialog>
  );
}
