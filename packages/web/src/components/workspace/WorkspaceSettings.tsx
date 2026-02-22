import React, { useEffect, useMemo, useState } from "react";
import { Download } from "lucide-react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../../hooks/useAuth";
import { showSuccessToast, showErrorToast } from "../../utils/toast";

type WorkspaceMember = {
  id: string;
  workspace_id: string | null;
  user_id: string | null;
  role: "owner" | "admin" | "member";
  joined_at: string;
  name: string;
  email: string;
  avatar_url: string | null;
};

type WorkspaceDetail = {
  workspace: {
    id: string;
    name: string;
    slug: string;
    owner_id: string | null;
    is_personal: boolean | null;
    created_at: string;
    updated_at: string;
  };
  members: WorkspaceMember[];
  currentUserRole: "owner" | "admin" | "member";
};

async function fetchWorkspace(slug: string): Promise<WorkspaceDetail> {
  const res = await fetch(`/api/workspaces/${slug}`);
  if (!res.ok) {
    throw new Error("Failed to fetch workspace");
  }
  return res.json();
}

export function WorkspaceSettings() {
  const { workspaceSlug } = useParams<{ workspaceSlug: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: session } = useAuth();

  const { data, isLoading, error } = useQuery({
    queryKey: ["workspace", workspaceSlug, "settings"],
    queryFn: () => fetchWorkspace(workspaceSlug ?? ""),
    enabled: !!workspaceSlug,
  });

  const [name, setName] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [inviteLoading, setInviteLoading] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (data?.workspace?.name) {
      setName(data.workspace.name);
    }
  }, [data?.workspace?.name]);

  const canManage = data?.currentUserRole === "owner" || data?.currentUserRole === "admin";
  const isOwner = data?.currentUserRole === "owner";

  const handleSaveName = async () => {
    if (!workspaceSlug || !data?.workspace) return;
    if (name.trim().length < 2) {
      setErrorMessage("Workspace name must be at least 2 characters.");
      return;
    }
    setErrorMessage(null);
    setIsSaving(true);
    try {
      const res = await fetch(`/api/workspaces/${workspaceSlug}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });
      if (!res.ok) {
        throw new Error("Failed to update workspace");
      }
      const updated = await res.json();
      queryClient.invalidateQueries({ queryKey: ["workspaces"] });
      queryClient.setQueryData(["workspace", workspaceSlug, "settings"], {
        ...data,
        workspace: updated,
      });
      if (updated.slug && updated.slug !== workspaceSlug) {
        navigate(`/app/${updated.slug}/settings`, { replace: true });
      }
      showSuccessToast("Workspace updated");
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Failed to update workspace";
      setErrorMessage(errorMessage);
      showErrorToast("Failed to update workspace");
    } finally {
      setIsSaving(false);
    }
  };

  const handleInvite = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!workspaceSlug) return;
    const trimmed = inviteEmail.trim();
    if (!trimmed) {
      setErrorMessage("Email is required.");
      return;
    }
    setErrorMessage(null);
    setInviteLoading(true);
    try {
      const res = await fetch(`/api/workspaces/${workspaceSlug}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: trimmed }),
      });
      if (!res.ok) {
        throw new Error("Failed to invite member");
      }
      await queryClient.invalidateQueries({ queryKey: ["workspace", workspaceSlug, "settings"] });
      setInviteEmail("");
      showSuccessToast("Member invited");
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Failed to invite member";
      setErrorMessage(errorMessage);
      showErrorToast("Failed to invite member");
    } finally {
      setInviteLoading(false);
    }
  };

  const handleRemove = async (member: WorkspaceMember) => {
    if (!workspaceSlug) return;
    setErrorMessage(null);
    try {
      const res = await fetch(`/api/workspaces/${workspaceSlug}/members/${member.user_id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        throw new Error("Failed to remove member");
      }
      await queryClient.invalidateQueries({ queryKey: ["workspace", workspaceSlug, "settings"] });
      showSuccessToast("Member removed");
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Failed to remove member";
      setErrorMessage(errorMessage);
      showErrorToast("Failed to remove member");
    }
  };

  const handleExportWorkspace = async () => {
    if (!data?.workspace?.id) return;
    setIsExporting(true);
    try {
      const res = await fetch(`/api/workspaces/${data.workspace.id}/export`);
      if (!res.ok) {
        throw new Error("Failed to export workspace");
      }
      const blob = await res.blob();
      const disposition = res.headers.get("content-disposition");
      const match = disposition?.match(/filename="?([^";]+)"?/i);
      const filename = match?.[1] ?? "workspace-export.zip";
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      showSuccessToast("Workspace exported");
    } catch (err) {
      showErrorToast("Failed to export workspace");
    } finally {
      setIsExporting(false);
    }
  };

  const members = useMemo(() => data?.members ?? [], [data?.members]);

  if (isLoading) {
    return <div className="text-sm text-zinc-500">Loading workspace...</div>;
  }

  if (error || !data) {
    return <div className="text-sm text-red-600">Failed to load workspace settings.</div>;
  }

  return (
    <div className="max-w-3xl space-y-8">
      <div>
        <Link to={`/app/${data.workspace.slug}`} className="text-sm text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100">
          Back to workspace
        </Link>
        <h1 className="mt-2 text-2xl font-semibold text-zinc-900 dark:text-zinc-100">Workspace settings</h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">Manage your workspace identity and members.</p>
      </div>

      <section className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-6 space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Workspace name</h2>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">This appears in navigation and on documents.</p>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={!canManage}
            className="flex-1 rounded-md border border-zinc-200 dark:border-zinc-700 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-zinc-500 disabled:bg-zinc-100 dark:disabled:bg-zinc-800"
          />
          {canManage && (
            <button
              type="button"
              onClick={handleSaveName}
              className="px-4 py-2 text-sm font-medium text-white bg-zinc-900 dark:bg-zinc-700 rounded-md hover:bg-zinc-800 dark:hover:bg-zinc-600 transition-colors disabled:opacity-60"
              disabled={isSaving}
            >
              {isSaving ? "Saving..." : "Save"}
            </button>
          )}
        </div>
        {errorMessage && <p className="text-sm text-red-600">{errorMessage}</p>}
      </section>

      <section className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-6 space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Invite members</h2>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">Invite existing users by email.</p>
        </div>
        <form onSubmit={handleInvite} className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <input
            value={inviteEmail}
            onChange={(event) => setInviteEmail(event.target.value)}
            type="email"
            className="flex-1 rounded-md border border-zinc-200 dark:border-zinc-700 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-zinc-500"
            placeholder="name@company.com"
            disabled={!canManage}
          />
          <button
            type="submit"
            disabled={!canManage || inviteLoading}
            className="px-4 py-2 text-sm font-medium text-white bg-zinc-900 dark:bg-zinc-700 rounded-md hover:bg-zinc-800 dark:hover:bg-zinc-600 transition-colors disabled:opacity-60"
          >
            {inviteLoading ? "Inviting..." : "Invite"}
          </button>
        </form>
      </section>

      <section className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-6 space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Export workspace</h2>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">Download all pages as markdown files in a zip.</p>
        </div>
        <div>
          <button
            type="button"
            onClick={handleExportWorkspace}
            disabled={isExporting}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-zinc-900 dark:bg-zinc-700 rounded-md hover:bg-zinc-800 dark:hover:bg-zinc-600 transition-colors disabled:opacity-60"
          >
            <Download size={16} />
            {isExporting ? "Exporting..." : "Export Workspace"}
          </button>
        </div>
      </section>

      <section className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-6 space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Members</h2>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">{members.length} members in this workspace.</p>
        </div>
        <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {members.map((member) => {
            const isSelf = session?.user?.id && member.user_id === session.user.id;
            const canRemove = canManage && !(member.role === "owner") && !isSelf;
            return (
              <div key={member.id} className="flex items-center gap-3 py-3 hover:bg-zinc-50 dark:hover:bg-zinc-800">
                <div className="h-9 w-9 rounded-full overflow-hidden bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center text-xs font-medium text-zinc-500 dark:text-zinc-400">
                  {member.avatar_url ? (
                    <img src={member.avatar_url} alt={member.name} className="h-full w-full object-cover" />
                  ) : (
                    member.name?.[0]?.toUpperCase() || "U"
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate">{member.name}</div>
                  <div className="text-xs text-zinc-500 dark:text-zinc-400 truncate">{member.email}</div>
                </div>
                <span className="text-xs font-medium text-zinc-600 dark:text-zinc-300 border border-zinc-200 dark:border-zinc-700 rounded-full px-2 py-1">
                  {member.role}
                </span>
                {canRemove && (
                  <button
                    type="button"
                    onClick={() => handleRemove(member)}
                    className="text-xs font-medium text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300"
                  >
                    Remove
                  </button>
                )}
              </div>
            );
          })}
        </div>
        {isOwner && (
          <p className="text-xs text-zinc-400 dark:text-zinc-500">
            Owners can remove members. You cannot remove the workspace owner.
          </p>
        )}
      </section>
    </div>
  );
}
