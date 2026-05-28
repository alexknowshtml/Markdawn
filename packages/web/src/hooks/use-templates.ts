import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { showErrorToast, showSuccessToast } from '../utils/toast';

const API_BASE = '/api';

export type TemplateContentBlock = unknown;

export interface Template {
  id: string;
  title: string;
  icon: string | null;
  description: string | null;
  contentBlocks: TemplateContentBlock[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

async function fetchTemplates(): Promise<Template[]> {
  const res = await fetch(`${API_BASE}/templates`);
  if (!res.ok) {
    throw new Error('Failed to fetch templates');
  }
  return res.json();
}

async function createTemplate(data: {
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

export function useTemplates() {
  return useQuery({
    queryKey: ['templates'],
    queryFn: () => fetchTemplates(),
  });
}

export function useCreateTemplate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createTemplate,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['templates'] });
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
    mutationFn: ({ templateId }: { templateId: string }) => deleteTemplate(templateId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['templates'] });
      showSuccessToast('Template deleted');
    },
    onError: () => {
      showErrorToast('Failed to delete template');
    },
  });
}
