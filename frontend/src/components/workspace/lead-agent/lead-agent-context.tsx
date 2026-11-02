"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { safeLocalStorage } from "@/core/settings/local";
import { uuid } from "@/core/utils/uuid";

const THREAD_STORAGE_KEY = "deerflow.lead-agent.thread-id";
const SKILL_STORAGE_KEY_PREFIX = "deerflow.lead-agent.skill.";

type LeadAgentContextValue = {
  threadId: string;
  isNewThread: boolean;
  historyOpen: boolean;
  activeSkillName: string | null;
  setActiveSkillName: (name: string | null) => void;
  newConversation: () => void;
  openThread: (threadId: string) => void;
  markThreadStarted: (threadId: string) => void;
  openHistory: () => void;
  closeHistory: () => void;
};

function skillStorageKey(threadId: string): string {
  return `${SKILL_STORAGE_KEY_PREFIX}${threadId}`;
}

function readActiveSkill(threadId: string): string | null {
  return safeLocalStorage.getItem(skillStorageKey(threadId));
}

function persistActiveSkill(threadId: string, name: string | null) {
  if (name) {
    safeLocalStorage.setItem(skillStorageKey(threadId), name);
  } else {
    safeLocalStorage.removeItem(skillStorageKey(threadId));
  }
}

const LeadAgentContext = createContext<LeadAgentContextValue | null>(null);

function persistThreadId(threadId: string | null) {
  if (threadId) {
    safeLocalStorage.setItem(THREAD_STORAGE_KEY, threadId);
  } else {
    safeLocalStorage.removeItem(THREAD_STORAGE_KEY);
  }
}

export function LeadAgentProvider({ children }: { children: ReactNode }) {
  const [threadId, setThreadId] = useState(() => uuid());
  const [isNewThread, setIsNewThread] = useState(true);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [activeSkillName, setActiveSkillState] = useState<string | null>(null);

  // Restore the last conversation after mount. The first render deliberately
  // uses a fresh id so server and client render the same empty composer.
  useEffect(() => {
    const stored = safeLocalStorage.getItem(THREAD_STORAGE_KEY);
    if (!stored) {
      return;
    }
    setThreadId(stored);
    setIsNewThread(false);
    setActiveSkillState(readActiveSkill(stored));
  }, []);

  const setActiveSkillName = useCallback(
    (name: string | null) => {
      setActiveSkillState(name);
      persistActiveSkill(threadId, name);
    },
    [threadId],
  );

  const newConversation = useCallback(() => {
    const nextThreadId = uuid();
    setThreadId(nextThreadId);
    setIsNewThread(true);
    setHistoryOpen(false);
    setActiveSkillState(null);
    persistThreadId(null);
  }, []);

  const openThread = useCallback((nextThreadId: string) => {
    setThreadId(nextThreadId);
    setIsNewThread(false);
    setHistoryOpen(false);
    setActiveSkillState(readActiveSkill(nextThreadId));
    persistThreadId(nextThreadId);
  }, []);

  const markThreadStarted = useCallback(
    (nextThreadId: string) => {
      if (nextThreadId !== threadId && activeSkillName) {
        persistActiveSkill(nextThreadId, activeSkillName);
        persistActiveSkill(threadId, null);
      }
      setThreadId(nextThreadId);
      setIsNewThread(false);
      persistThreadId(nextThreadId);
    },
    [activeSkillName, threadId],
  );

  const openHistory = useCallback(() => {
    setHistoryOpen(true);
  }, []);

  const closeHistory = useCallback(() => {
    setHistoryOpen(false);
  }, []);

  const value = useMemo<LeadAgentContextValue>(
    () => ({
      threadId,
      isNewThread,
      historyOpen,
      activeSkillName,
      setActiveSkillName,
      newConversation,
      openThread,
      markThreadStarted,
      openHistory,
      closeHistory,
    }),
    [
      activeSkillName,
      closeHistory,
      historyOpen,
      isNewThread,
      markThreadStarted,
      newConversation,
      openHistory,
      openThread,
      setActiveSkillName,
      threadId,
    ],
  );

  return (
    <LeadAgentContext.Provider value={value}>
      {children}
    </LeadAgentContext.Provider>
  );
}

export function useLeadAgent() {
  const context = useContext(LeadAgentContext);
  if (!context) {
    throw new Error("useLeadAgent must be used within a LeadAgentProvider");
  }
  return context;
}
