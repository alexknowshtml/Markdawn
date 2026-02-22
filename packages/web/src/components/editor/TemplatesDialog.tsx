import React, { useMemo, useState } from "react";
import { FileText, Plus, Trash2, LayoutTemplate } from "lucide-react";
import { useTemplates, useCreateTemplate, useDeleteTemplate, type Template } from "../../hooks/use-templates";

interface TemplatesDialogProps {
  workspaceId: string;
  onUseTemplate: (template: Template) => void;
}

export function TemplatesDialog({ workspaceId, onUseTemplate }: TemplatesDialogProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [newTemplateTitle, setNewTemplateTitle] = useState("");
  const [newTemplateIcon, setNewTemplateIcon] = useState("");
  const [newTemplateDescription, setNewTemplateDescription] = useState("");
  const { data: templates, isLoading } = useTemplates(isOpen ? workspaceId : "");
  const createTemplateMutation = useCreateTemplate();
  const deleteTemplateMutation = useDeleteTemplate();
  const canCreate = useMemo(() => newTemplateTitle.trim().length > 0, [newTemplateTitle]);

  const handleCreateTemplate = (event: React.FormEvent) => {
    event.preventDefault();
    const title = newTemplateTitle.trim();
    if (!title) {
      return;
    }

    createTemplateMutation.mutate({
      workspaceId,
      title,
      icon: newTemplateIcon.trim() ? newTemplateIcon.trim() : null,
      description: newTemplateDescription.trim() ? newTemplateDescription.trim() : null,
      contentBlocks: [],
    }, {
      onSuccess: () => {
        setIsCreating(false);
        setNewTemplateTitle("");
        setNewTemplateIcon("");
        setNewTemplateDescription("");
      },
    });
  };

  const handleUseTemplate = (template: Template) => {
    onUseTemplate(template);
    setIsOpen(false);
  };

  return (
    <div>
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className="px-3 py-2 text-sm font-medium text-zinc-700 dark:text-zinc-300 border border-zinc-200 dark:border-zinc-600 rounded-md hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors flex items-center gap-2"
      >
        <LayoutTemplate size={16} />
        Templates
      </button>

        {isOpen && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/40 backdrop-blur-sm px-4 animate-fade-in"
            onClick={() => setIsOpen(false)}
          >
          <div
            className="w-full max-w-2xl max-h-[80vh] flex flex-col rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-xl animate-slide-up overflow-hidden"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="p-6 border-b border-zinc-200 dark:border-zinc-800 flex justify-between items-center">
              <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50 flex items-center gap-2">
                <LayoutTemplate size={20} />
                Templates
              </h2>
              <button
                onClick={() => setIsCreating(!isCreating)}
                className="px-3 py-1.5 text-sm font-medium text-white bg-zinc-900 dark:bg-zinc-800 rounded-md hover:bg-zinc-800 dark:hover:bg-zinc-700 transition-colors flex items-center gap-1"
              >
                {isCreating ? "Cancel" : <><Plus size={16} /> Create Template</>}
              </button>
            </div>

            <div className="p-6 overflow-y-auto flex-1">
              {isCreating ? (
                <form onSubmit={handleCreateTemplate} className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">Template Title</label>
                    <input
                      type="text"
                      value={newTemplateTitle}
                      onChange={(e) => setNewTemplateTitle(e.target.value)}
                      placeholder="Meeting Notes"
                      className="w-full rounded-md border border-zinc-200 dark:border-zinc-700 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-50 bg-white dark:bg-zinc-800 focus:ring-2 focus:ring-zinc-900/10 dark:focus:ring-zinc-100/10 outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">Icon (optional)</label>
                    <input
                      type="text"
                      value={newTemplateIcon}
                      onChange={(e) => setNewTemplateIcon(e.target.value)}
                      placeholder="📄"
                      className="w-full rounded-md border border-zinc-200 dark:border-zinc-700 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-50 bg-white dark:bg-zinc-800 focus:ring-2 focus:ring-zinc-900/10 dark:focus:ring-zinc-100/10 outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">Description (optional)</label>
                    <textarea
                      value={newTemplateDescription}
                      onChange={(e) => setNewTemplateDescription(e.target.value)}
                      placeholder="What is this template for?"
                      className="w-full rounded-md border border-zinc-200 dark:border-zinc-700 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-50 bg-white dark:bg-zinc-800 focus:ring-2 focus:ring-zinc-900/10 dark:focus:ring-zinc-100/10 outline-none resize-none h-24"
                    />
                  </div>
                  <div className="flex justify-end gap-2 pt-2">
                    <button
                      type="button"
                      onClick={() => setIsCreating(false)}
                      className="px-4 py-2 text-sm text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-50"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={createTemplateMutation.isPending || !canCreate}
                      className="px-4 py-2 text-sm font-medium text-white bg-zinc-900 dark:bg-zinc-800 rounded-md hover:bg-zinc-800 dark:hover:bg-zinc-700 transition-colors disabled:opacity-60"
                    >
                      {createTemplateMutation.isPending ? "Saving..." : "Save Template"}
                    </button>
                  </div>
                </form>
              ) : (
                <div className="space-y-4">
                  {isLoading ? (
                    <div className="text-center py-8 text-zinc-500">Loading templates...</div>
                  ) : templates?.length === 0 ? (
                    <div className="text-center py-12 text-zinc-500 flex flex-col items-center">
                      <LayoutTemplate size={48} className="mb-4 text-zinc-300 dark:text-zinc-700" />
                      <p>No templates found in this workspace.</p>
                      <p className="text-sm mt-1">Create one from the current page to get started.</p>
                    </div>
                  ) : (
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {templates?.map((template) => (
                          <div
                            key={template.id}
                            className="border border-zinc-200 dark:border-zinc-800 rounded-lg p-4 hover:border-zinc-400 dark:hover:border-zinc-600 transition-colors group relative bg-white dark:bg-zinc-900"
                          >
                            <div className="flex items-start justify-between mb-2">
                              <div className="flex items-center gap-2">
                                <div className="w-8 h-8 rounded bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center text-lg">
                                  {template.icon || <FileText size={16} className="text-zinc-500" />}
                              </div>
                              <h3 className="font-medium text-zinc-900 dark:text-zinc-100 truncate max-w-[180px]">
                                {template.title}
                              </h3>
                            </div>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (confirm("Are you sure you want to delete this template?")) {
                                    deleteTemplateMutation.mutate({ templateId: template.id, workspaceId });
                                  }
                                }}
                                className="text-zinc-400 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity p-1"
                                title="Delete template"
                              >
                              <Trash2 size={16} />
                            </button>
                          </div>
                          {template.description && (
                            <p className="text-sm text-zinc-500 dark:text-zinc-400 line-clamp-2 mb-4">
                              {template.description}
                            </p>
                          )}
                            <button
                              onClick={() => handleUseTemplate(template)}
                              className="w-full mt-2 px-3 py-1.5 text-sm font-medium text-zinc-700 dark:text-zinc-200 bg-zinc-100 dark:bg-zinc-800 rounded hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors"
                            >
                              Use template
                            </button>
                          </div>
                        ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
