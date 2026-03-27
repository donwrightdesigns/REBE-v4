'use client';

import React, { useRef, useState, useEffect, useCallback } from 'react';
import Image from 'next/image';
import { Camera, X, Check, RotateCcw, Sparkles, Loader2 } from 'lucide-react';
import { Button } from './ui/button';

interface CameraCaptureProps {
  onCapture: (files: File[]) => void;
  onClose: () => void;
}

export default function CameraCapture({ onCapture, onClose }: CameraCaptureProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [capturedImages, setCapturedImages] = useState<string[]>([]);
  const [isTripleShot, setIsTripleShot] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isInitializing, setIsInitializing] = useState(true);

  const startCamera = useCallback(async () => {
    setIsInitializing(true);
    setError(null);
    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        video: { 
          facingMode: 'environment',
          width: { ideal: 1920 },
          height: { ideal: 1080 }
        },
        audio: false
      });
      setStream(mediaStream);
      if (videoRef.current) {
        videoRef.current.srcObject = mediaStream;
      }
    } catch (err) {
      console.error('Error accessing camera:', err);
      setError('Could not access camera. Please ensure you have granted permission.');
    } finally {
      setIsInitializing(false);
    }
  }, []);

  useEffect(() => {
    startCamera();
    return () => {
      if (stream) {
        stream.getTracks().forEach(track => track.stop());
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startCamera]);

  const takePhoto = () => {
    if (!videoRef.current || !canvasRef.current) return;

    const video = videoRef.current;
    const canvas = canvasRef.current;
    const context = canvas.getContext('2d');

    if (context) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      
      const imageData = canvas.toDataURL('image/jpeg', 0.9);
      setCapturedImages(prev => [...prev, imageData]);
    }
  };

  const handleDone = () => {
    const files = capturedImages.map((dataUrl, index) => {
      const arr = dataUrl.split(',');
      const mime = arr[0].match(/:(.*?);/)![1];
      const bstr = atob(arr[1]);
      let n = bstr.length;
      const u8arr = new Uint8Array(n);
      while (n--) {
        u8arr[n] = bstr.charCodeAt(n);
      }
      return new File([u8arr], `camera_capture_${Date.now()}_${index}.jpg`, { type: mime });
    });
    onCapture(files);
    onClose();
  };

  const removeImage = (index: number) => {
    setCapturedImages(prev => prev.filter((_, i) => i !== index));
  };

  const isComplete = isTripleShot ? capturedImages.length >= 3 : capturedImages.length >= 1;

  return (
    <div className="fixed inset-0 z-50 bg-black flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between p-4 text-white">
        <Button variant="ghost" size="icon" onClick={onClose} className="text-white hover:bg-white/10">
          <X className="w-6 h-6" />
        </Button>
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-indigo-400" />
          <span className="text-sm font-medium">Camera Mode</span>
        </div>
        <div className="w-10" /> {/* Spacer */}
      </div>

      {/* Camera Viewport */}
      <div className="flex-1 relative overflow-hidden bg-zinc-900 flex items-center justify-center">
        {isInitializing && (
          <div className="flex flex-col items-center text-white gap-4">
            <Loader2 className="w-8 h-8 animate-spin text-indigo-500" />
            <p className="text-sm">Initializing camera...</p>
          </div>
        )}
        
        {error && (
          <div className="p-8 text-center text-white">
            <p className="text-red-400 mb-4">{error}</p>
            <Button onClick={startCamera} variant="outline" className="text-white border-white/20">
              <RotateCcw className="w-4 h-4 mr-2" />
              Try Again
            </Button>
          </div>
        )}

        <video
          ref={videoRef}
          autoPlay
          playsInline
          className={`w-full h-full object-cover ${isInitializing || error ? 'hidden' : 'block'}`}
        />
        
        <canvas ref={canvasRef} className="hidden" />

        {/* Triple Shot Recommendation Overlay */}
        {isTripleShot && capturedImages.length < 3 && !isInitializing && !error && (
          <div className="absolute top-4 left-4 right-4 bg-black/60 backdrop-blur-md p-3 rounded-xl border border-white/10 text-white text-center">
            <p className="text-xs font-medium mb-1">Triple Shot Recommended</p>
            <p className="text-[10px] text-zinc-300">Snap 3 similar angles for the best AI results ({capturedImages.length}/3)</p>
          </div>
        )}
      </div>

      {/* Captured Thumbnails */}
      {capturedImages.length > 0 && (
        <div className="bg-zinc-900 p-4 flex gap-2 overflow-x-auto border-t border-white/5">
          {capturedImages.map((img, i) => (
            <div key={i} className="relative w-16 h-16 rounded-lg overflow-hidden flex-shrink-0 border border-white/20">
              <Image 
                src={img} 
                fill 
                className="object-cover" 
                alt="" 
                referrerPolicy="no-referrer"
              />
              <button 
                onClick={() => removeImage(i)}
                className="absolute top-0.5 right-0.5 bg-black/60 rounded-full p-0.5 z-10"
              >
                <X className="w-3 h-3 text-white" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Controls */}
      <div className="bg-black p-8 flex items-center justify-around">
        <div className="flex flex-col items-center gap-2">
          <Button 
            variant="ghost" 
            size="sm" 
            onClick={() => setIsTripleShot(!isTripleShot)}
            className={`text-[10px] uppercase tracking-wider ${isTripleShot ? 'text-indigo-400' : 'text-zinc-500'}`}
          >
            Triple Shot {isTripleShot ? 'ON' : 'OFF'}
          </Button>
        </div>

        <button
          onClick={takePhoto}
          disabled={isInitializing || !!error}
          className="w-16 h-16 rounded-full border-4 border-white flex items-center justify-center active:scale-95 transition-transform disabled:opacity-50"
        >
          <div className="w-12 h-12 rounded-full bg-white" />
        </button>

        <div className="flex flex-col items-center gap-2">
          {capturedImages.length > 0 && (
            <Button 
              onClick={handleDone}
              className="bg-indigo-600 hover:bg-indigo-700 text-white rounded-full px-6"
            >
              <Check className="w-4 h-4 mr-2" />
              Done
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
