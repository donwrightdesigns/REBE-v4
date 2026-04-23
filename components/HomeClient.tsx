'use client';

import { useState, useEffect } from 'react';
import { useAuth } from '@/components/auth-provider';
import { Button } from '@/components/ui/button';
import { LogIn, Image as ImageIcon, Key } from 'lucide-react';

import Dashboard from '@/components/Dashboard';

export default function HomeClient() {
  const { user, loading, signIn } = useAuth();
  const [hasApiKey, setHasApiKey] = useState<boolean | null>(null);

  useEffect(() => {
    const checkApiKey = async () => {
      const gWindow = window as unknown as { aistudio?: { hasSelectedApiKey: () => Promise<boolean>; openSelectKey: () => Promise<void> } };
      if (typeof window !== 'undefined' && gWindow.aistudio) {
        try {
          const hasKey = await gWindow.aistudio.hasSelectedApiKey();
          setHasApiKey(hasKey);
        } catch (e) {
          console.error('Error checking API key:', e);
          setHasApiKey(false);
        }
      } else {
        setHasApiKey(true); // Fallback if not in AI Studio
      }
    };
    checkApiKey();
  }, []);

  const selectApiKey = async () => {
    const gWindow = window as unknown as { aistudio?: { hasSelectedApiKey: () => Promise<boolean>; openSelectKey: () => Promise<void> } };
    if (typeof window !== 'undefined' && gWindow.aistudio) {
      try {
        await gWindow.aistudio.openSelectKey();
        setHasApiKey(true);
      } catch (e) {
        console.error('Error selecting API key:', e);
        if (e instanceof Error && e.message.includes("Requested entity was not found")) {
          setHasApiKey(false);
        }
      }
    }
  };

  if (loading || hasApiKey === null) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-zinc-950">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-500"></div>
      </div>
    );
  }

  if (!hasApiKey) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-zinc-950 p-4">
        <div className="max-w-md w-full bg-zinc-900 rounded-2xl shadow-xl border border-zinc-800 p-8 text-center">
          <div className="w-16 h-16 bg-indigo-500/20 text-indigo-400 rounded-2xl flex items-center justify-center mx-auto mb-6">
            <Key className="w-8 h-8" />
          </div>
          <h1 className="text-3xl font-bold text-zinc-100 mb-2">API Key Required</h1>
          <p className="text-zinc-400 mb-8">
            This app uses high-quality image generation models (Nano Banana 2 and Pro) which require a paid Google Cloud project API key.
          </p>
          <Button onClick={selectApiKey} className="w-full h-12 text-lg bg-indigo-500 hover:bg-indigo-600 text-white" size="lg">
            <Key className="w-5 h-5 mr-2" />
            Select API Key
          </Button>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-zinc-950 p-4">
        <div className="max-w-md w-full bg-zinc-900 rounded-2xl shadow-xl border border-zinc-800 p-8 text-center">
          <div className="w-16 h-16 bg-indigo-500/20 text-indigo-400 rounded-2xl flex items-center justify-center mx-auto mb-6">
            <ImageIcon className="w-8 h-8" />
          </div>
          <h1 className="text-3xl font-bold text-zinc-100 mb-2">Real Estate Beautifier</h1>
          <p className="text-zinc-400 mb-8">
            Batch exterior real estate beautification photo editor. Content-aware, context-aware, and simply beautifies with photographic realism.
          </p>
          <Button onClick={signIn} className="w-full h-12 text-lg bg-indigo-500 hover:bg-indigo-600 text-white" size="lg">
            <LogIn className="w-5 h-5 mr-2" />
            Sign in with Google
          </Button>
        </div>
      </div>
    );
  }

  return <Dashboard />;
}
