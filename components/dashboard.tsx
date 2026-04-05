'use client';

import { useState, useEffect, useCallback } from 'react';
import { useAuth } from './auth-provider';
import { db } from '@/lib/firebase';
import { collection, query, where, orderBy, onSnapshot, addDoc, getDocs, doc, setDoc, deleteDoc, updateDoc, limit } from 'firebase/firestore';
import { Button } from './ui/button';
import Image from 'next/image';
import { Plus, LogOut, FolderOpen, Clock, CheckSquare, Square, Merge, Edit2, Sparkles, Image as ImageIcon } from 'lucide-react';
import ProjectView from './project-view';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface Project {
  id: string;
  uid: string;
  name: string;
  address?: string;
  prompt: string;
  createdAt: number;
}

function ProjectThumbnailGrid({ projectId, uid }: { projectId: string, uid: string }) {
  const [thumbnails, setThumbnails] = useState<string[]>([]);

  useEffect(() => {
    if (!uid) return;
    const q = query(
      collection(db, 'projects', projectId, 'images'),
      where('uid', '==', uid),
      orderBy('createdAt', 'desc')
    );
    const unsub = onSnapshot(q, (snap) => {
      const urls = snap.docs.map(d => d.data().processedThumbnail || d.data().originalThumbnail).filter(Boolean);
      setThumbnails(urls.slice(0, 4));
    }, (error) => {
      console.error("Error fetching thumbnails:", error);
    });
    return () => unsub();
  }, [projectId, uid]);

  if (thumbnails.length === 0) {
    return (
      <div className="h-32 bg-[#2D3139] rounded-lg mb-4 flex items-center justify-center text-[#A0A4AB]">
        <ImageIcon className="w-8 h-8 opacity-20" />
      </div>
    );
  }

  return (
    <div className="h-32 grid grid-cols-2 gap-1 mb-4 rounded-lg overflow-hidden bg-[#2D3139]">
      {thumbnails.map((url, i) => {
        let spanClass = '';
        if (thumbnails.length === 1) spanClass = 'col-span-2 row-span-2';
        else if (thumbnails.length === 3 && i === 0) spanClass = 'col-span-2 row-span-1';
        else if (thumbnails.length === 2) spanClass = 'col-span-1 row-span-2';
        
        return (
          <div key={i} className={`relative overflow-hidden ${spanClass}`}>
            <Image 
              src={url} 
              fill
              className="object-cover" 
              alt="" 
              referrerPolicy="no-referrer"
            />
          </div>
        );
      })}
    </div>
  );
}

export default function Dashboard() {
  const { user, logOut } = useAuth();
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [newAddress, setNewAddress] = useState('');
  const [showStartupLogo, setShowStartupLogo] = useState(true);

  useEffect(() => {
    const timer = setTimeout(() => setShowStartupLogo(false), 2000);
    return () => clearTimeout(timer);
  }, []);
  
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [selectedProjects, setSelectedProjects] = useState<Set<string>>(new Set());
  const [isMergeDialogOpen, setIsMergeDialogOpen] = useState(false);
  const [mergeAddress, setMergeAddress] = useState('');
  const [isMerging, setIsMerging] = useState(false);

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
    if (!user) return;

    const q = query(
      collection(db, 'projects'),
      where('uid', '==', user.uid),
      orderBy('createdAt', 'desc')
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const projData: Project[] = [];
      snapshot.forEach((doc) => {
        projData.push({ id: doc.id, ...doc.data() } as Project);
      });
      setProjects(projData);
    });

    return () => unsubscribe();
  }, [user]);

  const createProject = async () => {
    if (!user) return;
    setIsCreating(true);
    const projectsPath = 'projects';
    try {
      const docRef = await addDoc(collection(db, projectsPath), {
        uid: user.uid,
        name: newAddress ? newAddress : `Batch ${new Date().toLocaleDateString()}`,
        address: newAddress,
        prompt: '',
        createdAt: Date.now(),
      });
      setActiveProjectId(docRef.id);
      setNewAddress('');
    } catch (error) {
      handleFirestoreError(error, 'create', projectsPath);
    } finally {
      setIsCreating(false);
    }
  };

  const toggleSelection = (id: string) => {
    const newSelection = new Set(selectedProjects);
    if (newSelection.has(id)) {
      newSelection.delete(id);
    } else {
      newSelection.add(id);
    }
    setSelectedProjects(newSelection);
  };

  const handleMerge = async () => {
    if (!user || selectedProjects.size === 0 || !mergeAddress.trim()) return;
    setIsMerging(true);
    
    try {
      const selectedIds = Array.from(selectedProjects);
      const targetProjectId = selectedIds[0];
      const sourceProjectIds = selectedIds.slice(1);
      
      // Update target project name/address
      const targetPath = `projects/${targetProjectId}`;
      try {
        await updateDoc(doc(db, targetPath), {
          name: mergeAddress,
          address: mergeAddress,
        });
      } catch (error) {
        throw handleFirestoreError(error, 'update', targetPath);
      }

      // Move images from source projects to target project
      for (const sourceId of sourceProjectIds) {
        const sourceImagesPath = `projects/${sourceId}/images`;
        let imagesSnapshot;
        try {
          imagesSnapshot = await getDocs(query(
            collection(db, sourceImagesPath),
            where('uid', '==', user.uid)
          ));
        } catch (error) {
          throw handleFirestoreError(error, 'list', sourceImagesPath);
        }

        for (const imageDoc of imagesSnapshot.docs) {
          const imageData = imageDoc.data();
          const targetImagesPath = `projects/${targetProjectId}/images/${imageDoc.id}`;
          // Copy to target
          try {
            await setDoc(doc(db, 'projects', targetProjectId, 'images', imageDoc.id), {
              ...imageData,
              projectId: targetProjectId
            });
          } catch (error) {
            throw handleFirestoreError(error, 'create', targetImagesPath);
          }
          
          // Delete from source
          const sourceImagePath = `projects/${sourceId}/images/${imageDoc.id}`;
          try {
            await deleteDoc(doc(db, sourceImagePath));
          } catch (error) {
            throw handleFirestoreError(error, 'delete', sourceImagePath);
          }
        }
        
        // Delete source project
        const sourceProjectPath = `projects/${sourceId}`;
        try {
          await deleteDoc(doc(db, sourceProjectPath));
        } catch (error) {
          throw handleFirestoreError(error, 'delete', sourceProjectPath);
        }
      }

      setIsSelectionMode(false);
      setSelectedProjects(new Set());
      setIsMergeDialogOpen(false);
      setMergeAddress('');
    } catch (error: any) {
      console.error('Error merging projects:', error.message || error);
    } finally {
      setIsMerging(false);
    }
  };

  const [isRenameDialogOpen, setIsRenameDialogOpen] = useState(false);
  const [projectToRename, setProjectToRename] = useState<Project | null>(null);
  const [renameAddress, setRenameAddress] = useState('');
  const [isRenaming, setIsRenaming] = useState(false);

  const handleRename = async () => {
    if (!projectToRename || !renameAddress.trim()) return;
    setIsRenaming(true);
    try {
      const projectPath = `projects/${projectToRename.id}`;
      try {
        await updateDoc(doc(db, projectPath), {
          name: renameAddress,
          address: renameAddress,
        });
      } catch (error) {
        throw handleFirestoreError(error, 'update', projectPath);
      }
      setIsRenameDialogOpen(false);
      setProjectToRename(null);
      setRenameAddress('');
    } catch (error: any) {
      console.error('Error renaming project:', error.message || error);
    } finally {
      setIsRenaming(false);
    }
  };

  if (activeProjectId) {
    return <ProjectView projectId={activeProjectId} onBack={() => setActiveProjectId(null)} />;
  }

  return (
    <div className="min-h-screen bg-[#2D3139] flex flex-col font-sans">
      {showStartupLogo && (
        <div className="fixed inset-0 z-[100] bg-[#2D3139] flex flex-col items-center justify-center animate-in fade-in duration-500">
          <div className="w-24 h-24 bg-[#D1604D] rounded-3xl flex items-center justify-center shadow-2xl mb-6 animate-bounce">
            <Sparkles className="w-12 h-12 text-white" />
          </div>
          <h1 className="text-2xl font-display font-black text-white uppercase tracking-tighter">
            WRIGHT CREATIVE
          </h1>
        </div>
      )}

      <header className="bg-[#2D3139] border-b border-white/5 sticky top-0 z-20">
        <div className="max-w-[1600px] mx-auto px-4 md:px-6 h-16 md:h-20 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="w-10 h-10 bg-[#D1604D] rounded-xl flex items-center justify-center shadow-lg shadow-black/20">
              <Sparkles className="w-6 h-6 text-white" />
            </div>
            <div className="hidden sm:block">
              <h1 className="text-sm font-display font-bold tracking-tighter text-white uppercase leading-none">
                WRIGHT CREATIVE
              </h1>
              <p className="text-[8px] font-display font-medium tracking-[0.2em] text-[#A0A4AB] uppercase mt-1">
                BATCH ENHANCEMENT ENGINE
              </p>
            </div>
          </div>

          <div className="flex items-center gap-4 md:gap-6">
            <div className="flex items-center gap-3">
              <div className="relative w-8 h-8 md:w-10 md:h-10 rounded-xl overflow-hidden bg-[#3E434D] border border-white/5">
                <Image 
                  src={user?.photoURL || 'https://picsum.photos/seed/user/200/200'} 
                  fill
                  className="object-cover"
                  alt="" 
                  referrerPolicy="no-referrer"
                />
              </div>
              <div className="hidden md:block">
                <p className="text-[10px] font-display font-bold text-white uppercase tracking-widest leading-none mb-1">{user?.displayName}</p>
                <p className="text-[8px] font-display text-[#A0A4AB] uppercase tracking-widest leading-none">PRO ACCOUNT</p>
              </div>
            </div>
            <Button variant="ghost" size="icon" onClick={logOut} title="Sign out" className="text-[#A0A4AB] hover:text-white hover:bg-[#3E434D] rounded-xl">
              <LogOut className="w-5 h-5" />
            </Button>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-[1600px] w-full mx-auto px-6 py-12">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between mb-12 gap-6">
          <div className="flex items-center gap-6">
            <h2 className="text-4xl font-display font-black text-white uppercase tracking-tight">YOUR BATCHES</h2>
            {projects.length > 0 && (
              <Button 
                variant={isSelectionMode ? "secondary" : "outline"}
                size="sm"
                className={isSelectionMode ? "bg-[#D1604D] text-white rounded-full px-6" : "bg-[#3E434D] text-[#A0A4AB] border-white/5 rounded-full px-6"}
                onClick={() => {
                  setIsSelectionMode(!isSelectionMode);
                  if (isSelectionMode) setSelectedProjects(new Set());
                }}
              >
                {isSelectionMode ? 'CANCEL SELECTION' : 'SELECT BATCHES'}
              </Button>
            )}
          </div>
          <div className="flex items-center gap-4 w-full sm:w-auto">
            <div className="relative flex-1 sm:w-80">
              <input
                type="text"
                placeholder="PROPERTY ADDRESS (OPTIONAL)"
                value={newAddress}
                onChange={(e) => setNewAddress(e.target.value)}
                className="w-full bg-[#3E434D] border border-white/5 rounded-2xl px-6 py-4 text-xs font-display font-bold text-white placeholder-[#A0A4AB]/30 focus:outline-none focus:border-[#D1604D]/50 uppercase tracking-widest"
              />
            </div>
            <Button onClick={createProject} disabled={isCreating} className="bg-[#D1604D] hover:bg-[#E1705D] text-white font-display font-bold uppercase tracking-widest px-8 py-7 rounded-2xl shadow-xl shadow-[#D1604D]/20">
              <Plus className="w-5 h-5 mr-2" />
              NEW BATCH
            </Button>
          </div>
        </div>

        {projects.length === 0 ? (
          <div className="text-center py-32 bg-[#3E434D]/20 rounded-[48px] border-2 border-dashed border-[#D1604D]/30">
            <div className="w-20 h-20 bg-[#3E434D] rounded-3xl flex items-center justify-center mx-auto mb-8 shadow-2xl border border-white/5">
              <FolderOpen className="w-10 h-10 text-[#D1604D]" />
            </div>
            <h3 className="text-2xl font-display font-black text-white uppercase tracking-tight mb-4">NO BATCHES YET</h3>
            <p className="text-[#A0A4AB] font-display font-bold uppercase tracking-widest mb-12">CREATE A NEW BATCH TO START BEAUTIFYING PHOTOS</p>
            <Button onClick={createProject} disabled={isCreating} className="bg-[#D1604D] hover:bg-[#E1705D] text-white font-display font-bold uppercase tracking-widest px-12 py-7 rounded-2xl shadow-xl shadow-[#D1604D]/20">
              <Plus className="w-5 h-5 mr-2" />
              CREATE FIRST BATCH
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-10">
            {projects.map((project) => (
              <div
                key={project.id}
                onClick={() => {
                  if (isSelectionMode) {
                    toggleSelection(project.id);
                  } else {
                    setActiveProjectId(project.id);
                  }
                }}
                className={`bg-[#3E434D] rounded-[40px] border p-8 cursor-pointer transition-all duration-500 group relative ${
                  selectedProjects.has(project.id) 
                    ? 'border-[#D1604D] shadow-2xl shadow-[#D1604D]/10' 
                    : 'border-white/5 hover:border-[#D1604D]/30 hover:shadow-2xl hover:shadow-black/40'
                }`}
              >
                {isSelectionMode && (
                  <div className="absolute top-6 right-6 z-10">
                    <div className={`w-8 h-8 rounded-xl flex items-center justify-center border-2 transition-all ${
                      selectedProjects.has(project.id) 
                        ? 'bg-[#D1604D] border-[#D1604D]' 
                        : 'bg-[#2D3139] border-white/10'
                    }`}>
                      {selectedProjects.has(project.id) && <CheckSquare className="w-5 h-5 text-white" />}
                    </div>
                  </div>
                )}
                
                <div className="mb-8">
                  <ProjectThumbnailGrid projectId={project.id} uid={user?.uid || ''} />
                </div>

                <div className="space-y-4">
                  <div className="flex items-start justify-between">
                    <div>
                      <h3 className="text-xl font-display font-black text-white uppercase tracking-tight group-hover:text-[#D1604D] transition-colors">
                        {project.name}
                      </h3>
                      <div className="flex items-center gap-2 mt-2">
                        <Clock className="w-3 h-3 text-[#A0A4AB]" />
                        <span className="text-[10px] font-display font-bold text-[#A0A4AB] uppercase tracking-widest">
                          {new Date(project.createdAt).toLocaleDateString()}
                        </span>
                      </div>
                    </div>
                    {!isSelectionMode && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="opacity-0 group-hover:opacity-100 transition-opacity text-[#A0A4AB] hover:text-[#D1604D] hover:bg-[#2D3139] rounded-xl"
                        onClick={(e) => {
                          e.stopPropagation();
                          setProjectToRename(project);
                          setRenameAddress(project.name);
                          setIsRenameDialogOpen(true);
                        }}
                      >
                        <Edit2 className="w-4 h-4" />
                      </Button>
                    )}
                  </div>
                  
                  {project.prompt && (
                    <p className="text-xs font-display italic text-[#A0A4AB] line-clamp-2 leading-relaxed">
                      &quot;{project.prompt}&quot;
                    </p>
                  )}

                  <div className="pt-6 border-t border-white/5 flex items-center justify-between">
                    <div className="flex gap-2">
                      <div className="bg-[#2D3139] px-3 py-1 rounded-lg border border-white/5 text-[8px] font-display font-bold text-[#A0A4AB] uppercase tracking-widest">
                        INTERIOR
                      </div>
                      <div className="bg-[#2D3139] px-3 py-1 rounded-lg border border-white/5 text-[8px] font-display font-bold text-[#A0A4AB] uppercase tracking-widest">
                        EXTERIOR
                      </div>
                    </div>
                    <div className="w-8 h-8 rounded-full bg-[#2D3139] flex items-center justify-center border border-white/5 group-hover:bg-[#D1604D] transition-colors">
                      <FolderOpen className="w-4 h-4 text-white" />
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>

      {isSelectionMode && selectedProjects.size > 0 && (
        <div className="fixed bottom-12 left-1/2 -translate-x-1/2 z-50">
          <Button 
            onClick={() => setIsMergeDialogOpen(true)}
            className="bg-[#D1604D] hover:bg-[#E1705D] text-white font-display font-bold uppercase tracking-widest px-12 py-8 rounded-[32px] shadow-2xl shadow-[#D1604D]/40 border-4 border-[#2D3139]"
          >
            <Merge className="w-5 h-5 mr-3" />
            COMBINE & RENAME ({selectedProjects.size})
          </Button>
        </div>
      )}

      <Dialog open={isMergeDialogOpen} onOpenChange={setIsMergeDialogOpen}>
        <DialogContent className="bg-[#3E434D] border-white/5 text-white rounded-[40px] p-10">
          <DialogHeader>
            <DialogTitle className="text-2xl font-display font-black uppercase tracking-tight">COMBINE BATCHES</DialogTitle>
            <DialogDescription className="text-[#A0A4AB] font-display font-medium uppercase tracking-widest text-xs mt-2">
              MERGING {selectedProjects.size} SELECTED BATCHES INTO ONE
            </DialogDescription>
          </DialogHeader>
          <div className="py-8">
            <input
              type="text"
              placeholder="NEW PROPERTY ADDRESS"
              value={mergeAddress}
              onChange={(e) => setMergeAddress(e.target.value)}
              className="w-full bg-[#2D3139] border border-white/5 rounded-2xl px-6 py-4 text-sm font-display font-bold text-white placeholder-[#A0A4AB]/30 focus:outline-none focus:border-[#D1604D]/50 uppercase tracking-widest"
              autoFocus
            />
          </div>
          <DialogFooter className="gap-4">
            <Button variant="outline" onClick={() => setIsMergeDialogOpen(false)} disabled={isMerging} className="flex-1 bg-[#2D3139] border-white/5 text-[#A0A4AB] hover:text-white rounded-2xl py-6 uppercase tracking-widest font-bold">CANCEL</Button>
            <Button onClick={handleMerge} disabled={!mergeAddress.trim() || isMerging} className="flex-1 bg-[#D1604D] hover:bg-[#E1705D] text-white rounded-2xl py-6 uppercase tracking-widest font-bold shadow-xl shadow-[#D1604D]/20">
              {isMerging ? 'MERGING...' : 'MERGE & RENAME'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={isRenameDialogOpen} onOpenChange={setIsRenameDialogOpen}>
        <DialogContent className="bg-[#3E434D] border-white/5 text-white rounded-[40px] p-10">
          <DialogHeader>
            <DialogTitle className="text-2xl font-display font-black uppercase tracking-tight">RENAME BATCH</DialogTitle>
            <DialogDescription className="text-[#A0A4AB] font-display font-medium uppercase tracking-widest text-xs mt-2">
              ENTER THE NEW PROPERTY ADDRESS OR NAME
            </DialogDescription>
          </DialogHeader>
          <div className="py-8">
            <input
              type="text"
              placeholder="PROPERTY ADDRESS"
              value={renameAddress}
              onChange={(e) => setRenameAddress(e.target.value)}
              className="w-full bg-[#2D3139] border border-white/5 rounded-2xl px-6 py-4 text-sm font-display font-bold text-white placeholder-[#A0A4AB]/30 focus:outline-none focus:border-[#D1604D]/50 uppercase tracking-widest"
              autoFocus
            />
          </div>
          <DialogFooter className="gap-4">
            <Button variant="outline" onClick={() => setIsRenameDialogOpen(false)} disabled={isRenaming} className="flex-1 bg-[#2D3139] border-white/5 text-[#A0A4AB] hover:text-white rounded-2xl py-6 uppercase tracking-widest font-bold">CANCEL</Button>
            <Button onClick={handleRename} disabled={!renameAddress.trim() || isRenaming} className="flex-1 bg-[#D1604D] hover:bg-[#E1705D] text-white rounded-2xl py-6 uppercase tracking-widest font-bold shadow-xl shadow-[#D1604D]/20">
              {isRenaming ? 'RENAMING...' : 'RENAME'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
