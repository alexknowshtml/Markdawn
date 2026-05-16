import {
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { clsx } from 'clsx';
import {
  Activity,
  Calendar,
  ChevronDown,
  ChevronRight,
  Clock,
  ExternalLink,
  GripVertical,
  Link,
  Mail,
  Plus,
  Tag as TagIcon,
  Trash2,
  Type,
  User,
  X,
} from 'lucide-react';
import type React from 'react';
import { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useUpdatePage } from '../../hooks/use-pages';
import { useWorkspaceMetadata } from '../../hooks/useWorkspaceMetadata';

interface PropertiesPanelProps {
  pageId: string;
  workspaceId: string;
  properties: Record<string, unknown> | null;
}

interface PropertyItem {
  id: string; // Truly stable internal ID
  key: string;
  value: unknown;
}

// --- Helpers ---

const getIconForKey = (key: string) => {
  const k = key.toLowerCase();
  if (k.includes('date') || k.includes('created') || k.includes('updated')) return Calendar;
  if (k.includes('author') || k.includes('user') || k.includes('owner')) return User;
  if (k.includes('url') || k.includes('link') || k.includes('website')) return Link;
  if (k.includes('email')) return Mail;
  if (k.includes('time') || k.includes('duration')) return Clock;
  if (k.includes('tag')) return TagIcon;
  if (k.includes('status')) return Activity;
  return Type;
};

const isDate = (val: string) => {
  if (!val || val.length < 8) return false;
  const d = new Date(val);
  return (
    d instanceof Date && !Number.isNaN(d.getTime()) && (val.includes('-') || val.includes('/'))
  );
};

const formatDate = (val: string) => {
  try {
    const d = new Date(val);
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    }).format(d);
  } catch {
    return val;
  }
};

const isUrl = (val: string) => {
  try {
    return val.startsWith('http://') || val.startsWith('https://');
  } catch {
    return false;
  }
};

const getStatusColor = (status: string) => {
  const s = status.toLowerCase();
  // Obsidian-style monochrome muted status
  if (s === 'done' || s === 'completed' || s === 'finished' || s === 'closed')
    return 'bg-zinc-200 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-300 border-zinc-300 dark:border-zinc-600';
  return 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400 border-zinc-200 dark:border-zinc-700';
};

// --- Sub-components ---

interface TagValueEditorProps {
  tags: string[];
  onChange: (newTags: string[]) => void;
  suggestions: string[];
  onBlur?: () => void;
}

const TagValueEditor = forwardRef<HTMLInputElement, TagValueEditorProps>(
  ({ tags, onChange, suggestions, onBlur }, ref) => {
    const [inputValue, setInputValue] = useState('');
    const [isFocused, setIsFocused] = useState(false);
    const [selectedIndex, setSelectedIndex] = useState(0);

    const filteredSuggestions = useMemo(() => {
      if (!inputValue) return [];
      return suggestions.filter(
        (s) => s.toLowerCase().includes(inputValue.toLowerCase()) && !tags.includes(s),
      );
    }, [inputValue, suggestions, tags]);

    const addTag = (tag: string) => {
      const trimmed = tag.trim();
      if (trimmed && !tags.includes(trimmed)) {
        onChange([...tags, trimmed]);
      }
      setInputValue('');
    };

    const removeTag = (tagToRemove: string) => {
      onChange(tags.filter((t) => t !== tagToRemove));
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        if (filteredSuggestions.length > 0) {
          e.preventDefault();
          setSelectedIndex((prev) => (prev + 1) % filteredSuggestions.length);
        }
      } else if (e.key === 'ArrowUp') {
        if (filteredSuggestions.length > 0) {
          e.preventDefault();
          setSelectedIndex(
            (prev) => (prev - 1 + filteredSuggestions.length) % filteredSuggestions.length,
          );
        }
      } else if (e.key === 'Enter' || e.key === 'Tab' || e.key === ',') {
        if (filteredSuggestions.length > 0 && (e.key === 'Enter' || e.key === 'Tab')) {
          e.preventDefault();
          const selected = filteredSuggestions[selectedIndex];
          if (selected) {
            addTag(selected);
          }
        } else {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            addTag(inputValue);
          }
        }
      } else if (e.key === 'Backspace' && !inputValue && tags.length > 0) {
        const lastTag = tags[tags.length - 1];
        if (lastTag !== undefined) {
          removeTag(lastTag);
        }
      }
    };

    return (
      <div className="flex flex-wrap items-center gap-1.5 min-h-[1.75rem] py-0.5">
        {tags.map((tag) => (
          <span
            key={tag}
            className="flex items-center gap-1 px-2 py-0.5 bg-zinc-100 dark:bg-zinc-800/80 border border-zinc-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-300 text-[12px] rounded-full font-medium leading-none group/tag transition-colors"
          >
            {tag}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                removeTag(tag);
              }}
              className="p-0.5 rounded-full hover:bg-zinc-200 dark:hover:bg-zinc-700 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 transition-colors"
            >
              <X size={11} />
            </button>
          </span>
        ))}
        <div className="relative flex-1 min-w-[80px]">
          <input
            ref={ref}
            type="text"
            value={inputValue}
            onChange={(e) => {
              setInputValue(e.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={handleKeyDown}
            onFocus={() => setIsFocused(true)}
            onBlur={() => {
              setIsFocused(false);
              if (onBlur) onBlur();
            }}
            placeholder={tags.length === 0 ? 'Empty' : 'Add tag...'}
            className="w-full !bg-transparent !border-0 !border-none !shadow-none !outline-none text-[15px] py-0 px-1 placeholder:text-zinc-400 text-zinc-800 dark:text-zinc-200 caret-zinc-800 dark:caret-zinc-200 !focus:ring-0 !focus-visible:ring-0 !focus:outline-none !ring-0 !ring-offset-0 appearance-none"
            style={{ border: 'none', outline: 'none', boxShadow: 'none', background: 'transparent' }}
          />
          {isFocused && filteredSuggestions.length > 0 && (
            <div className="absolute top-full left-0 mt-1 w-48 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg shadow-xl z-50 overflow-hidden py-1">
              {filteredSuggestions.map((s, i) => (
                <button
                  key={s}
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    addTag(s);
                  }}
                  className={clsx(
                    'w-full text-left px-3 py-1.5 text-[13px] transition-colors !outline-none !ring-0 !ring-offset-0 !focus:ring-0',
                    i === selectedIndex
                      ? 'bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100'
                      : 'text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800/50',
                  )}
                >
                  {s}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  },
);
TagValueEditor.displayName = 'TagValueEditor';

interface PropertyKeySelectorProps {
  currentKey: string;
  onSelect: (newKey: string) => void;
  suggestions: string[];
  isEditing: boolean;
  setIsEditing: (val: boolean) => void;
}

function PropertyKeySelector({
  currentKey,
  onSelect,
  suggestions,
  isEditing,
  setIsEditing,
}: PropertyKeySelectorProps) {
  const [inputValue, setInputValue] = useState(currentKey);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const availableSuggestions = useMemo(() => {
    const query = inputValue.toLowerCase();
    const filtered = suggestions.filter((s) => s.toLowerCase().includes(query) && s !== currentKey);
    return filtered.length > 0 ? filtered : suggestions.slice(0, 8);
  }, [inputValue, suggestions, currentKey]);

  useEffect(() => {
    if (isEditing) {
      setInputValue(currentKey === 'New Property' || currentKey === '' ? '' : currentKey);
      setTimeout(() => {
        inputRef.current?.focus();
      }, 0);
    }
  }, [isEditing, currentKey]);

  const handleSelect = (key: string) => {
    onSelect(key);
    setIsEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      if (availableSuggestions.length > 0) {
        e.preventDefault();
        setSelectedIndex((prev) => (prev + 1) % availableSuggestions.length);
      }
    } else if (e.key === 'ArrowUp') {
      if (availableSuggestions.length > 0) {
        e.preventDefault();
        setSelectedIndex(
          (prev) => (prev - 1 + availableSuggestions.length) % availableSuggestions.length,
        );
      }
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      if (availableSuggestions.length > 0) {
        const selected = availableSuggestions[selectedIndex];
        if (selected) {
          handleSelect(selected);
        }
      } else {
        handleSelect(inputValue || currentKey);
      }
    } else if (e.key === 'Escape') {
      setIsEditing(false);
      setInputValue(currentKey);
    }
  };

  if (!isEditing) {
    const Icon = getIconForKey(currentKey);
    return (
      <button
        type="button"
        onClick={() => setIsEditing(true)}
        className="flex items-center gap-2 text-[13px] font-medium text-zinc-500 dark:text-zinc-400 truncate cursor-text px-1.5 py-0.5 rounded transition-colors text-left w-36 shrink-0 group/key !outline-none !ring-0 !ring-offset-0 !focus:ring-0 !focus-visible:ring-0 !focus:outline-none !border-0"
        style={{ border: 'none', outline: 'none', boxShadow: 'none', background: 'transparent' }}
      >
        <Icon size={15} className="text-zinc-400 shrink-0" />
        <span className="truncate">{currentKey || 'New Property'}</span>
      </button>
    );
  }

  return (
    <div className="relative w-36 shrink-0">
      <input
        ref={inputRef}
        type="text"
        value={inputValue}
        onChange={(e) => {
          setInputValue(e.target.value);
          setSelectedIndex(0);
        }}
        onKeyDown={handleKeyDown}
        onBlur={() => {
          setTimeout(() => {
            if (inputRef.current) {
              handleSelect(inputValue.trim() || currentKey);
            }
          }, 150);
        }}
        className="w-full text-[13px] font-medium !bg-transparent !border-0 !border-none !shadow-none !outline-none !focus:ring-0 !focus-visible:ring-0 !ring-0 !ring-offset-0 text-zinc-900 dark:text-zinc-100 p-0 pl-1.5 appearance-none"
        style={{ border: 'none', outline: 'none', boxShadow: 'none', background: 'transparent' }}
        placeholder="Property name..."
      />
      <div className="absolute top-full left-0 mt-1 w-48 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg shadow-xl z-50 overflow-hidden py-1">
        {availableSuggestions.map((s, i) => {
          const Svg = getIconForKey(s);
          return (
            <button
              key={s}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                handleSelect(s);
              }}
              className={clsx(
                'w-full text-left px-3 py-2 text-[13px] transition-colors flex items-center gap-2 !outline-none !ring-0 !ring-offset-0 !focus:ring-0',
                i === selectedIndex
                  ? 'bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100'
                  : 'text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800/50',
              )}
            >
              <Svg size={13} className="text-zinc-400" />
              {s}
            </button>
          );
        })}
      </div>
    </div>
  );
}

interface SortablePropertyRowProps {
  item: PropertyItem;
  onUpdate: (id: string, value: unknown) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, newKey: string) => void;
  workspaceMetadata: { allKeys: string[]; allTags: string[] };
  isNew?: boolean;
}

function SortablePropertyRow({
  item,
  onUpdate,
  onDelete,
  onRename,
  workspaceMetadata,
  isNew,
}: SortablePropertyRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id,
  });

  const [isEditingValue, setIsEditingValue] = useState(false);
  const [tempValue, setTempValue] = useState(() => {
    if (Array.isArray(item.value)) return item.value.join(', ');
    return String(item.value ?? '');
  });

  const valueInputRef = useRef<HTMLInputElement>(null);
  const tagEditorRef = useRef<HTMLInputElement>(null);
  const [isEditingKey, setIsEditingKey] = useState(isNew ?? false);

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 50 : undefined,
  };

  const handleValueSave = (nextValue?: unknown) => {
    setIsEditingValue(false);
    const finalValue = nextValue !== undefined ? nextValue : tempValue.trim();
    if (finalValue !== (Array.isArray(item.value) ? item.value.join(', ') : item.value)) {
      onUpdate(item.id, finalValue);
    }
  };

  useEffect(() => {
    if (isEditingValue) {
      valueInputRef.current?.focus();
    }
  }, [isEditingValue]);

  const isTagsProperty = item.key.toLowerCase() === 'tags' || item.key.toLowerCase() === 'tag';

  const handleKeySelect = useCallback(
    (newKey: string) => {
      onRename(item.id, newKey);
      // Auto-focus the value area after selecting a property key
      const isTag = newKey.toLowerCase() === 'tags' || newKey.toLowerCase() === 'tag';
      if (isTag) {
        setTimeout(() => tagEditorRef.current?.focus(), 0);
      } else {
        setIsEditingValue(true);
      }
    },
    [item.id, onRename],
  );

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={clsx(
        'group flex items-center gap-2 px-2 py-1.5 rounded-lg transition-all duration-200 border border-transparent',
        isDragging
          ? 'bg-white dark:bg-zinc-800 shadow-xl border-zinc-200 dark:border-zinc-700'
          : 'hover:bg-zinc-100/50 dark:hover:bg-zinc-800/40',
      )}
    >
      <div
        {...attributes}
        {...listeners}
        className="opacity-0 group-hover:opacity-100 cursor-grab active:cursor-grabbing p-1 -ml-2 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 transition-opacity"
      >
        <GripVertical size={15} />
      </div>

      <PropertyKeySelector
        currentKey={item.key}
        onSelect={handleKeySelect}
        suggestions={workspaceMetadata.allKeys}
        isEditing={isEditingKey}
        setIsEditing={setIsEditingKey}
      />

      <div className="flex-1 min-w-0 flex items-center gap-2">
        {isTagsProperty ? (
          <TagValueEditor
            ref={tagEditorRef}
            tags={Array.isArray(item.value) ? (item.value as string[]) : []}
            suggestions={workspaceMetadata.allTags}
            onChange={(newTags) => onUpdate(item.id, newTags)}
          />
        ) : isEditingValue ? (
          <input
            ref={valueInputRef}
            type="text"
            className="w-full text-[15px] !bg-transparent !border-0 !border-none !shadow-none !outline-none !focus:ring-0 !focus-visible:ring-0 !ring-0 !ring-offset-0 text-zinc-900 dark:text-zinc-100 caret-zinc-900 dark:caret-zinc-100 p-0 appearance-none"
            style={{
              border: 'none',
              outline: 'none',
              boxShadow: 'none',
              background: 'transparent',
            }}
            value={tempValue}
            onChange={(e) => setTempValue(e.target.value)}
            onBlur={() => handleValueSave()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleValueSave();
              if (e.key === 'Escape') {
                setIsEditingValue(false);
                setTempValue(
                  Array.isArray(item.value) ? item.value.join(', ') : String(item.value ?? ''),
                );
              }
            }}
          />
        ) : (
          <button
            type="button"
            onClick={() => setIsEditingValue(true)}
            className="flex-1 text-[15px] text-zinc-800 dark:text-zinc-200 truncate cursor-text px-2 py-0.5 rounded min-h-[1.75rem] flex items-center transition-colors text-left !outline-none !ring-0 !ring-offset-0 !focus:ring-0 !focus-visible:ring-0 !focus:outline-none !border-0"
            style={{
              border: 'none',
              outline: 'none',
              boxShadow: 'none',
              background: 'transparent',
            }}
          >
            {item.key.toLowerCase() === 'status' ? (
              <span
                className={clsx(
                  'px-2 py-0.5 rounded-md text-[12px] font-bold border uppercase tracking-wider transition-colors',
                  getStatusColor(String(item.value)),
                )}
              >
                {String(item.value || 'Empty')}
              </span>
            ) : isUrl(String(item.value)) ? (
              <a
                href={String(item.value)}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-1.5"
              >
                <span className="truncate">{String(item.value)}</span>
                <ExternalLink size={11} className="shrink-0" />
              </a>
            ) : isDate(String(item.value)) ? (
              <div className="flex items-center gap-2">
                <span className="font-medium text-zinc-800 dark:text-zinc-200">
                  {formatDate(String(item.value))}
                </span>
                <span className="text-[11px] text-zinc-400 font-normal tabular-nums">
                  ({String(item.value)})
                </span>
              </div>
            ) : (
              <span className={clsx(!item.value && 'text-zinc-400 dark:text-zinc-600')}>
                {String(item.value || 'Empty')}
              </span>
            )}
          </button>
        )}
      </div>

      <button
        type="button"
        onClick={() => onDelete(item.id)}
        className="opacity-0 group-hover:opacity-100 p-1.5 text-zinc-400 hover:text-red-500 transition-all cursor-pointer rounded-md hover:bg-red-50 dark:hover:bg-red-500/10 shrink-0 !outline-none !ring-0 !ring-offset-0 !focus:ring-0"
        title="Delete property"
      >
        <Trash2 size={15} />
      </button>
    </div>
  );
}

// --- Main Component ---

export function PropertiesPanel({ pageId, workspaceId, properties }: PropertiesPanelProps) {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [items, setItems] = useState<PropertyItem[]>([]);
  const [newPropertyId, setNewPropertyId] = useState<string | null>(null);
  const updatePage = useUpdatePage();
  const workspaceMetadata = useWorkspaceMetadata(workspaceId);

  // Sync internal items with props while preserving order
  useEffect(() => {
    if (!properties) {
      setItems([]);
      return;
    }

    const propEntries = Object.entries(properties);

    setItems((currentItems) => {
      const newItems: PropertyItem[] = [];
      const handledKeys = new Set<string>();

      // 1. Keep existing items that are still in properties, update their values
      for (const item of currentItems) {
        if (item.id.startsWith('new-')) {
          newItems.push(item);
          handledKeys.add(item.key);
          continue;
        }

        if (Object.prototype.hasOwnProperty.call(properties, item.key)) {
          newItems.push({
            ...item,
            value: properties[item.key],
          });
          handledKeys.add(item.key);
        }
      }

      // 2. Add new properties from the backend that aren't in our list yet
      for (const [key, value] of propEntries) {
        if (!handledKeys.has(key)) {
          newItems.push({
            id: key, // Use key as ID for existing properties from backend
            key,
            value,
          });
        }
      }

      return newItems;
    });
  }, [properties]);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const persistChanges = useCallback(
    (newItems: PropertyItem[]) => {
      const nextProperties: Record<string, unknown> = {};
      for (const item of newItems) {
        const key = item.key.trim();
        if (!key) continue;

        const existing = nextProperties[key];
        if (existing !== undefined) {
          if (Array.isArray(existing) && Array.isArray(item.value)) {
            nextProperties[key] = [...new Set([...existing, ...item.value])];
          } else {
            nextProperties[key] = item.value;
          }
        } else {
          nextProperties[key] = item.value;
        }
      }
      updatePage.mutate({ pageId, updates: { properties: nextProperties }, silent: true });
    },
    [pageId, updatePage],
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;

    if (over && active.id !== over.id) {
      setItems((prev) => {
        const oldIndex = prev.findIndex((i) => i.id === active.id);
        const newIndex = prev.findIndex((i) => i.id === over.id);
        const next = arrayMove(prev, oldIndex, newIndex);
        persistChanges(next);
        return next;
      });
    }
  };

  const updateProperty = (id: string, value: unknown) => {
    setItems((prev) => {
      const next = prev.map((it) => (it.id === id ? { ...it, value } : it));
      persistChanges(next);
      return next;
    });
  };

  const deleteProperty = (id: string) => {
    setItems((prev) => {
      const next = prev.filter((it) => it.id !== id);
      persistChanges(next);
      return next;
    });
  };

  const renameProperty = (id: string, newKey: string) => {
    if (!newKey || items.some((it) => it.id !== id && it.key === newKey)) {
      setItems((prev) => [...prev]); // Trigger re-render to revert invalid input
      return;
    }
    setItems((currentItems) => {
      const next = currentItems.map((it) => (it.id === id ? { ...it, key: newKey } : it));
      // Use a timeout to allow the state to settle before persisting
      setTimeout(() => persistChanges(next), 0);
      return next;
    });
    setNewPropertyId(null);
  };

  const addProperty = () => {
    const newId = `new-${Math.random().toString(36).slice(2, 11)}`;
    setItems((prev) => [...prev, { id: newId, key: '', value: '' }]);
    setNewPropertyId(newId);
    setIsCollapsed(false);
  };

  if (items.length === 0 && !isCollapsed) {
    return (
      <div className="mb-6 animate-fade-in px-2">
        <button
          type="button"
          onClick={addProperty}
          className="flex items-center gap-2 px-3 py-1.5 text-[13px] font-medium text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-lg transition-all cursor-pointer group border border-dashed border-zinc-200 dark:border-zinc-800 hover:border-zinc-300 dark:hover:border-zinc-700 !outline-none !focus:outline-none !focus:ring-0 !focus-visible:ring-0 !ring-0 !ring-offset-0"
        >
          <Plus size={15} className="group-hover:scale-110 transition-transform" />
          Add a property
        </button>
      </div>
    );
  }

  return (
    <div className="mb-10 select-none animate-fade-in">
      <div className="flex items-center justify-between mb-3 px-2">
        <button
          type="button"
          onClick={() => setIsCollapsed(!isCollapsed)}
          className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-zinc-600 dark:text-zinc-300 cursor-pointer group !outline-none !focus:outline-none !focus:ring-0 !focus-visible:ring-0 !ring-0 !ring-offset-0"
        >
          <div className="p-0.5 rounded">
            {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          </div>
          <span>Properties</span>
          <span className="bg-zinc-100 dark:bg-zinc-800/80 px-2 py-0.5 rounded-full text-[11px] normal-case tracking-normal font-black">
            {items.length}
          </span>
        </button>
      </div>

      {!isCollapsed && (
        <div className="space-y-1">
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext items={items} strategy={verticalListSortingStrategy}>
              {items.map((item) => (
                <SortablePropertyRow
                  key={item.id}
                  item={item}
                  isNew={newPropertyId === item.id}
                  onUpdate={updateProperty}
                  onDelete={deleteProperty}
                  onRename={renameProperty}
                  workspaceMetadata={workspaceMetadata}
                />
              ))}
            </SortableContext>
          </DndContext>

          <button
            type="button"
            onClick={addProperty}
            className="w-full flex items-center gap-2 px-2 py-2 mt-2 text-[13px] font-medium text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 hover:bg-zinc-100/50 dark:hover:bg-zinc-800/40 rounded-lg transition-all cursor-pointer group border border-dashed border-transparent hover:border-zinc-200 dark:hover:border-zinc-700 !outline-none !focus:outline-none !focus:ring-0 !focus-visible:ring-0 !ring-0 !ring-offset-0"
          >
            <Plus size={15} className="group-hover:scale-110 transition-transform" />
            <span>Add a property</span>
          </button>
        </div>
      )}
    </div>
  );
}
