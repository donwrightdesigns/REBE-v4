'use client';

import { useState, useRef, useEffect } from 'react';
import { Button } from './ui/button';
import { Mic, Square, Loader2, Volume2 } from 'lucide-react';
import { GoogleGenAI, LiveServerMessage, Modality, Type, Session } from '@google/genai';

interface VoicePromptProps {
  onPromptGenerated: (prompt: string) => void;
}

export default function VoicePrompt({ onPromptGenerated }: VoicePromptProps) {
  const [isRecording, setIsRecording] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [transcript, setTranscript] = useState('');
  
  const sessionRef = useRef<Promise<Session> | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const audioQueueRef = useRef<Float32Array[]>([]);
  const isPlayingRef = useRef(false);

  const playNextAudio = async () => {
    if (isPlayingRef.current || audioQueueRef.current.length === 0 || !audioContextRef.current) return;
    
    isPlayingRef.current = true;
    const pcmData = audioQueueRef.current.shift()!;
    
    const audioBuffer = audioContextRef.current.createBuffer(1, pcmData.length, 24000);
    audioBuffer.getChannelData(0).set(pcmData);
    
    const source = audioContextRef.current.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(audioContextRef.current.destination);
    
    source.onended = () => {
      isPlayingRef.current = false;
      playNextAudio();
    };
    
    source.start();
  };

  const startRecording = async () => {
    setIsConnecting(true);
    setTranscript('');
    
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.NEXT_PUBLIC_GEMINI_API_KEY });
      
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;
      
      const audioCtx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)({ sampleRate: 16000 });
      audioContextRef.current = audioCtx;
      
      const source = audioCtx.createMediaStreamSource(stream);
      sourceRef.current = source;
      
      const processor = audioCtx.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;
      
      source.connect(processor);
      processor.connect(audioCtx.destination);
      
      const sessionPromise = ai.live.connect({
        model: "gemini-3.1-flash-live-preview",
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: "Zephyr" } },
          },
          systemInstruction: "You are a helpful real estate photography assistant. Ask the user how they want their exterior real estate photos beautified. Once they describe it, say 'I will set the prompt to: [THE PROMPT]' and use the setPrompt tool. IMPORTANT: The generated prompt MUST instruct the AI to maintain the exact architectural structure and scene layout of the original image. It should avoid adding fictional elements or changing the environment significantly. Focus on refinements to lighting, sky, and landscaping while keeping the house and surroundings realistic.",
          tools: [{
            functionDeclarations: [{
              name: "setPrompt",
              description: "Sets the beautification prompt based on the user's description.",
              parameters: {
                type: Type.OBJECT,
                properties: {
                  prompt: { type: Type.STRING, description: "The detailed prompt to apply to the images." }
                },
                required: ["prompt"]
              }
            }]
          }]
        },
        callbacks: {
          onopen: () => {
            setIsConnecting(false);
            setIsRecording(true);
            
            processor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const pcm16 = new Int16Array(inputData.length);
              for (let i = 0; i < inputData.length; i++) {
                pcm16[i] = Math.max(-1, Math.min(1, inputData[i])) * 0x7FFF;
              }
              
              const base64Data = btoa(String.fromCharCode(...new Uint8Array(pcm16.buffer)));
              
              sessionPromise.then((session: Session) => {
                session.sendRealtimeInput({
                  media: { data: base64Data, mimeType: 'audio/pcm;rate=16000' }
                });
              });
            };
          },
            onmessage: async (message: LiveServerMessage) => {
              // Handle audio output
              const base64Audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
              if (base64Audio) {
                const binaryString = atob(base64Audio);
                const pcm16 = new Int16Array(binaryString.length / 2);
                for (let i = 0; i < pcm16.length; i++) {
                  pcm16[i] = binaryString.charCodeAt(i * 2) | (binaryString.charCodeAt(i * 2 + 1) << 8);
                }
                const float32 = new Float32Array(pcm16.length);
                for (let i = 0; i < pcm16.length; i++) {
                  float32[i] = pcm16[i] / 0x7FFF;
                }
                
                audioQueueRef.current.push(float32);
                playNextAudio();
              }
              
              // Handle tool calls
              const functionCalls = message.toolCall?.functionCalls;
              if (functionCalls) {
                for (const call of functionCalls) {
                  if (call.name === 'setPrompt' && call.args) {
                    const args = call.args as { prompt?: string };
                    const promptArg = args.prompt;
                    if (promptArg) {
                      onPromptGenerated(promptArg);
                      setTranscript(`Prompt set: ${promptArg}`);
                      
                      // Send response back
                      sessionPromise.then((session: Session) => {
                        session.sendToolResponse({
                          functionResponses: [{
                            id: call.id,
                            name: call.name,
                            response: { result: "Success" }
                          }]
                        });
                      });
                    }
                  }
                }
              }
            },
          onclose: () => {
            stopRecording();
          },
          onerror: (err) => {
            console.error("Live API Error:", err);
            stopRecording();
          }
        }
      });
      
      sessionRef.current = sessionPromise;
      
    } catch (error) {
      console.error('Error starting voice prompt:', error);
      setIsConnecting(false);
    }
  };

  const stopRecording = () => {
    setIsRecording(false);
    setIsConnecting(false);
    
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (sourceRef.current) {
      sourceRef.current.disconnect();
      sourceRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(track => track.stop());
      mediaStreamRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    if (sessionRef.current) {
      sessionRef.current.then((session: Session) => session.close());
      sessionRef.current = null;
    }
    audioQueueRef.current = [];
    isPlayingRef.current = false;
  };

  useEffect(() => {
    return () => stopRecording();
  }, []);

  return (
    <div className="flex items-center gap-2">
      {!isRecording ? (
        <Button 
          variant="secondary" 
          size="icon" 
          onClick={startRecording}
          disabled={isConnecting}
          className="rounded-full bg-indigo-100 hover:bg-indigo-200 text-indigo-600"
          title="Voice Assistant"
        >
          {isConnecting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Mic className="w-4 h-4" />}
        </Button>
      ) : (
        <div className="flex items-center gap-2 bg-indigo-50 px-3 py-1 rounded-full border border-indigo-100">
          <Volume2 className="w-4 h-4 text-indigo-500 animate-pulse" />
          <span className="text-xs font-medium text-indigo-700">Listening...</span>
          <Button 
            variant="ghost" 
            size="icon" 
            onClick={stopRecording}
            className="w-6 h-6 rounded-full hover:bg-indigo-200 text-indigo-700"
            title="Stop Recording"
          >
            <Square className="w-3 h-3" />
          </Button>
        </div>
      )}
      {transcript && <span className="text-xs text-emerald-600 font-medium ml-2">{transcript}</span>}
    </div>
  );
}
