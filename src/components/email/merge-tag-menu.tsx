"use client";

import { CodeBracketIcon } from "@heroicons/react/20/solid";
import { useApp } from "@/components/app-context";
import { Button } from "@/components/ui/button";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger } from "@/components/ui/menu";
import { campaignMergeTags, mergeTagLabels, mergeTags } from "@/lib/email/merge-tags";

/**
 * "Insert field": the merge tags an email can use, plus the person's custom
 * fields. Campaigns leave out the sender tags, since there's no one sender.
 */
export function MergeTagMenu({ onInsert, campaign = false, disabled, className }: { onInsert: (tag: string) => void; campaign?: boolean; disabled?: boolean; className?: string }) {
  const { customFields } = useApp();
  const custom = customFields.filter((f) => f.entityType === "person");
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button size="sm" variant="ghost" className={className} disabled={disabled}>
          <CodeBracketIcon />
          Insert field
        </Button>
      </MenuTrigger>
      {/* Keep focus where the tag went (the editor or subject), so typing carries on. */}
      <MenuContent align="end" className="max-h-80 w-72 overflow-auto" onCloseAutoFocus={(e) => e.preventDefault()}>
        <MenuLabel>{campaign ? "Filled in for each person" : "Filled in when sent"}</MenuLabel>
        {(campaign ? campaignMergeTags : mergeTags).map((t) => (
          <MenuItem key={t} onSelect={() => onInsert(t)}>
            <span className="min-w-0 truncate">{mergeTagLabels[t]}</span>
            <span className="ml-auto shrink-0 font-mono text-[11px] text-faint">{`{{${t}}}`}</span>
          </MenuItem>
        ))}
        {custom.length ? (
          <>
            <MenuLabel>Custom fields</MenuLabel>
            {custom.map((f) => (
              <MenuItem key={f.id} onSelect={() => onInsert(`custom.${f.key}`)}>
                <span className="truncate">{f.label}</span>
              </MenuItem>
            ))}
          </>
        ) : null}
      </MenuContent>
    </Menu>
  );
}
