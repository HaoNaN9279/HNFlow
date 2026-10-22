"use client";

import { PromptInputProvider } from "@/components/ai-elements/prompt-input";
import { SubtasksProvider } from "@/core/tasks/context";

export function LeadAgentProviders({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <SubtasksProvider>
      <PromptInputProvider>{children}</PromptInputProvider>
    </SubtasksProvider>
  );
}
