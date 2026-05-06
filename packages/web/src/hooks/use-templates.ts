import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { showErrorToast, showSuccessToast } from '../utils/toast';

const API_BASE = '/api';

export type TemplateContentBlock = unknown;

export interface Template {
  id: string;
  workspaceId: string;
  title: string;
  icon: string | null;
  description: string | null;
  contentBlocks: TemplateContentBlock[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

async function fetchTemplates(workspaceId: string): Promise<Template[]> {
  const res = await fetch(`${API_BASE}/templates?workspaceId=${workspaceId}`);
  if (!res.ok) {
    throw new Error('Failed to fetch templates');
  }
  return res.json();
}

async function createTemplate(data: {
  workspaceId: string;
  title: string;
  icon?: string | null;
  description?: string | null;
  contentBlocks: TemplateContentBlock[];
}): Promise<Template> {
  const res = await fetch(`${API_BASE}/templates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    throw new Error('Failed to create template');
  }
  return res.json();
}

async function deleteTemplate(templateId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/templates/${templateId}`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    throw new Error('Failed to delete template');
  }
}

export function useTemplates(workspaceId: string) {
  return useQuery({
    queryKey: ['templates', workspaceId],
    queryFn: () => fetchTemplates(workspaceId),
    enabled: !!workspaceId,
  });
}

export function useCreateTemplate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createTemplate,
    onSuccess: (_, { workspaceId }) => {
      queryClient.invalidateQueries({ queryKey: ['templates', workspaceId] });
      showSuccessToast('Template created');
    },
    onError: () => {
      showErrorToast('Failed to create template');
    },
  });
}

export function useDeleteTemplate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ templateId }: { templateId: string; workspaceId: string }) =>
      deleteTemplate(templateId),
    onSuccess: (_, { workspaceId }) => {
      queryClient.invalidateQueries({ queryKey: ['templates', workspaceId] });
      showSuccessToast('Template deleted');
    },
    onError: () => {
      showErrorToast('Failed to delete template');
    },
  });
}
