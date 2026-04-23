import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-[#2D3139] text-white">
      <h2 className="text-4xl font-display font-black uppercase mb-4">404</h2>
      <p className="text-[#A0A4AB] font-display font-bold uppercase tracking-widest text-center px-4">
        Resource not found
      </p>
      <Link href="/" className="mt-8 px-8 py-3 bg-[#D1604D] rounded-full font-display font-bold uppercase tracking-widest hover:bg-[#E1705D] transition-colors">
        Return Home
      </Link>
    </div>
  );
}
