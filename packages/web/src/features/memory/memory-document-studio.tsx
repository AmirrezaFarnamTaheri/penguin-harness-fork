import { useState, useEffect } from "react";
import type { ChangeEvent } from "react";
import type { MemoryTopicNode } from "./memory-types";
import { validateMemoryFrontmatter, formatBytes } from "./memory-types";
import { Button } from "../../components/ui/button";
import { Input, Textarea } from "../../components/ui/input";

function SaveIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
      <polyline points="17 21 17 13 7 13 7 21" />
      <polyline points="7 3 7 8 15 8" />
    </svg>
  );
}

function TrashIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

function CheckCircleIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <polyline points="22 4 12 14.01 9 11.01" />
    </svg>
  );
}

function AlertCircleIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}

function FileTextIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
      <polyline points="10 9 9 9 8 9" />
    </svg>
  );
}

function TagIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
      <line x1="7" y1="7" x2="7.01" y2="7" />
    </svg>
  );
}

function ClockIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

export interface MemoryDocumentStudioProps {
  topic: MemoryTopicNode | null;
  onSaveTopic: (id: string, updatedContent: string, newTitle?: string) => void;
  onDeleteTopic: (id: string) => void;
}

export function MemoryDocumentStudio({
  topic,
  onSaveTopic,
  onDeleteTopic,
}: MemoryDocumentStudioProps) {
  const [content, setContent] = useState("");
  const [title, setTitle] = useState("");
  const [isDirty, setIsDirty] = useState(false);

  useEffect(() => {
    if (topic) {
      setContent(topic.content);
      setTitle(topic.title);
      setIsDirty(false);
    } else {
      setContent("");
      setTitle("");
      setIsDirty(false);
    }
  }, [topic]);

  if (!topic) {
    return (
      <div className="h-full flex flex-col items-center justify-center p-6 text-center border border-border rounded-lg bg-card/40 text-muted-foreground">
        <FileTextIcon size={40} />
        <p className="text-sm font-medium mt-2">No Topic Selected</p>
        <p className="text-xs text-muted-foreground mt-1 max-w-xs">
          Select a node from the Knowledge Graph or topic list to view, edit frontmatter, and manage
          memory content.
        </p>
      </div>
    );
  }

  const frontmatterCheck = validateMemoryFrontmatter(content);

  const handleContentChange = (newVal: string) => {
    setContent(newVal);
    setIsDirty(true);
  };

  const handleTitleChange = (newVal: string) => {
    setTitle(newVal);
    setIsDirty(true);
  };

  const handleSave = () => {
    onSaveTopic(topic.id, content, title);
    setIsDirty(false);
  };

  const handleDelete = () => {
    if (confirm(`Are you sure you want to delete memory topic "${topic.name}"?`)) {
      onDeleteTopic(topic.id);
    }
  };

  return (
    <div className="flex flex-col h-full border border-border rounded-lg bg-card overflow-hidden">
      {/* Studio Header */}
      <div className="p-3.5 border-b border-border bg-muted/20 flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <span
              className={`text-[10px] px-2 py-0.5 rounded font-medium border uppercase tracking-wider ${
                topic.scope === "user"
                  ? "bg-blue-500/10 text-blue-400 border-blue-500/20"
                  : "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
              }`}
            >
              {topic.scope}
            </span>
            <span className="font-semibold text-xs text-foreground truncate">{topic.name}</span>
          </div>

          <div className="flex items-center gap-1.5">
            <Button
              size="sm"
              variant="danger"
              onClick={handleDelete}
              className="h-7"
              title="Delete Topic"
            >
              <TrashIcon size={14} />
              <span>Delete</span>
            </Button>
            <Button
              size="sm"
              variant={isDirty ? "primary" : "secondary"}
              onClick={handleSave}
              disabled={!isDirty || !frontmatterCheck.valid}
              className="h-7"
            >
              <SaveIcon size={14} />
              <span>Save</span>
            </Button>
          </div>
        </div>

        {/* Editable Title */}
        <div className="flex items-center gap-2">
          <Input
            size="sm"
            value={title}
            onChange={(e: ChangeEvent<HTMLInputElement>) => handleTitleChange(e.target.value)}
            placeholder="Topic title..."
            className="h-7 font-medium"
          />
        </div>

        {/* Status Bar */}
        <div className="flex items-center justify-between text-[11px] text-muted-foreground pt-1 border-t border-border/50">
          <div className="flex items-center gap-3">
            <span>{formatBytes(topic.bytes)}</span>
            <span>•</span>
            <span>{topic.tokens} tokens</span>
            <span>•</span>
            <span className="flex items-center gap-1">
              <ClockIcon size={12} />
              {new Date(topic.updatedAt).toLocaleDateString()}
            </span>
          </div>

          <div className="flex items-center gap-1.5">
            {frontmatterCheck.valid ? (
              <span className="flex items-center gap-1 text-emerald-500 font-medium">
                <CheckCircleIcon size={12} />
                Valid Frontmatter
              </span>
            ) : (
              <span className="flex items-center gap-1 text-destructive font-medium">
                <AlertCircleIcon size={12} />
                Invalid Frontmatter
              </span>
            )}
          </div>
        </div>

        {/* Tags */}
        {topic.tags.length > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap pt-0.5">
            <TagIcon size={12} />
            {topic.tags.map((tag) => (
              <span
                key={tag}
                className="text-[10px] bg-secondary text-secondary-foreground px-1.5 py-0.5 rounded"
              >
                {tag}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Markdown Content Editor */}
      <div className="flex-1 p-3 flex flex-col min-h-0">
        <Textarea
          size="sm"
          value={content}
          onChange={(e: ChangeEvent<HTMLTextAreaElement>) => handleContentChange(e.target.value)}
          placeholder="Memory topic markdown content..."
          className="flex-1 font-mono resize-none leading-relaxed"
        />
      </div>
    </div>
  );
}
