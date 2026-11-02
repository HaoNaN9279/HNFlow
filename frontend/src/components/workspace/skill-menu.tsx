"use client";

import { BookOpenIcon, CheckIcon } from "lucide-react";
import { useMemo, useState } from "react";

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Tooltip } from "@/components/workspace/tooltip";
import { useI18n } from "@/core/i18n/hooks";
import { useSkills } from "@/core/skills/hooks";

export function SkillMenu({
  activeSkillName,
  onSelect,
  disabled,
}: {
  activeSkillName: string | null;
  onSelect: (name: string | null) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const { skills, isLoading } = useSkills();
  const groups = useMemo(() => {
    const enabled = skills
      .filter((skill) => skill.enabled)
      .sort((left, right) => left.name.localeCompare(right.name));
    const byCategory = new Map<string, typeof enabled>();
    for (const skill of enabled) {
      const category = skill.category || "other";
      const items = byCategory.get(category) ?? [];
      items.push(skill);
      byCategory.set(category, items);
    }
    return [...byCategory.entries()];
  }, [skills]);

  const choose = (name: string) => {
    onSelect(activeSkillName === name ? null : name);
    setOpen(false);
  };

  return (
    <>
      <Tooltip content={t.leadAgent.skillMenu}>
        <button
          type="button"
          aria-label={t.leadAgent.skillMenu}
          disabled={disabled}
          onClick={() => setOpen(true)}
          className="text-muted-foreground hover:text-foreground hover:bg-accent inline-flex size-7 items-center justify-center rounded-md transition-colors disabled:pointer-events-none disabled:opacity-50"
          data-testid="lead-agent-skill-menu"
        >
          <BookOpenIcon className="size-4" />
        </button>
      </Tooltip>
      <CommandDialog
        open={open}
        onOpenChange={setOpen}
        title={t.leadAgent.skillMenu}
        description={t.leadAgent.skillMenu}
      >
        <CommandInput placeholder={t.leadAgent.skillMenu} />
        <CommandList>
          <CommandEmpty>
            {isLoading ? "Loading..." : t.leadAgent.skillMenuEmpty}
          </CommandEmpty>
          {groups.map(([category, items]) => (
            <CommandGroup key={category} heading={category}>
              {items.map((skill) => (
                <CommandItem
                  key={skill.name}
                  value={`${skill.name} ${skill.description}`}
                  onSelect={() => choose(skill.name)}
                >
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-medium">{skill.name}</span>
                    <span className="text-muted-foreground truncate text-xs">
                      {skill.description}
                    </span>
                  </div>
                  {activeSkillName === skill.name && (
                    <CheckIcon className="ml-auto size-4" />
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          ))}
        </CommandList>
      </CommandDialog>
    </>
  );
}
