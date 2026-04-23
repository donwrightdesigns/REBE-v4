'use client';

import { useEffect } from 'react';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-[#2D3139] text-white p-4 text-center">
      <h2 className="text-4xl font-display font-black uppercase mb-4">Something went wrong!</h2>
      <p className="text-[#A0A4AB] font-display font-bold uppercase tracking-widest mb-8 max-w-md mx-auto">
        {error.message || 'An unexpected error occurred during processing.'}
      </p>
      <button
        onClick={() => reset()}
        className="px-8 py-3 bg-[#D1604D] rounded-full font-display font-bold uppercase tracking-widest hover:bg-[#E1705D] transition-colors"
      >
        Try again
      </button>
    </div>
  );
}
