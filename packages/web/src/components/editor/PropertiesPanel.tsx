import React, { useState, useCallback } from "react";
import { Tag, Check, X, Pencil } from "lucide-react";
import { useUpdatePage } from "../../hooks/use-pages";

interface PropertiesPanelProps {
  pageId: string;
  properties: Record<string, unknown> | null;
}

export function PropertiesPanel({ pageId, properties }: PropertiesPanelProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValues, setEditValues] = useState<Record<string, string>>({});
  const updatePage = useUpdatePage();

  const entries = properties ? Object.entries(properties) : [];

  const startEditing = useCallback(() => {
    const initial: Record<string, string> = {};
    entries.forEach(([key, value]) => {
      initial[key] = Array.isArray(value) ? value.join(", ") : String(value);
    });
    setEditValues(initial);
    setIsEditing(true);
  }, [entries]);

  const cancelEditing = useCallback(() => {
    setIsEditing(false);
    setEditValues({});
  }, []);

  const saveEditing = useCallback(() => {
    const nextProperties: Record<string, unknown> = {};
    Object.entries(editValues).forEach(([key, value]) => {
      const trimmed = value.trim();
      if (trimmed.length > 0) {
        if (trimmed.includes(",")) {
          nextProperties[key] = trimmed.split(",").map((v) => v.trim()).filter(Boolean);
        } else {
          nextProperties[key] = trimmed;
        }
      }
    });

    updatePage.mutate(
      { pageId, updates: { properties: nextProperties } },
      {
        onSuccess: () => {
          setIsEditing(false);
        },
      }
    );
  }, [editValues, pageId, updatePage]);

  const handleChange = (key: string, value: string) => {
    setEditValues((prev) => ({ ...prev, [key]: value }));
  };

  if (entries.length === 0 && !isEditing) {
    return null;
  }

  return (
    <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-800/30 p-4 mb-6">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Tag size={14} className="text-zinc-500 dark:text-zinc-400" />
          <span className="text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
            Properties
          </span>
        </div>
        {!isEditing ? (
          <button
            type="button"
            onClick={startEditing}
            className="p-1 rounded hover:bg-zinc-200 dark:hover:bg-zinc-700 text-zinc-500 dark:text-zinc-400 transition-colors cursor-pointer"
            title="Edit properties"
          >
            <Pencil size={12} />
          </button>
        ) : (
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={saveEditing}
              disabled={updatePage.isPending}
              className="p-1 rounded hover:bg-zinc-200 dark:hover:bg-zinc-700 text-green-600 dark:text-green-400 transition-colors cursor-pointer disabled:opacity-50"
              title="Save"
            >
              <Check size={12} />
            </button>
            <button
              type="button"
              onClick={cancelEditing}
              className="p-1 rounded hover:bg-zinc-200 dark:hover:bg-zinc-700 text-red-500 dark:text-red-400 transition-colors cursor-pointer"
              title="Cancel"
            >
              <X size={12} />
            </button>
          </div>
        )}
      </div>
      <div className="space-y-2">
        {entries.map(([key, value]) => (
          <div key={key} className="flex items-start gap-3">
            <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400 shrink-0 w-24 truncate">
              {key}
            </span>
            {isEditing ? (
              <input
                type="text"
                value={editValues[key] ?? ""}
                onChange={(e) => handleChange(key, e.target.value)}
                className="flex-1 min-w-0 text-sm bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-600 rounded px-2 py-0.5 text-zinc-800 dark:text-zinc-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            ) : (
              <span className="text-sm text-zinc-800 dark:text-zinc-200">
                {Array.isArray(value) ? value.join(", ") : String(value)}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
