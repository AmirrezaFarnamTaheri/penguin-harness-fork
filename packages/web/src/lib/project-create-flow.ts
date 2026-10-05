/**
 * Refresh the authoritative Project list before selecting a newly created Project. The
 * list refresh can fail after the create request has succeeded (for example during a
 * transient disconnect), so surface that failure instead of detaching an unhandled
 * promise rejection from the sidebar event handler.
 */
export async function refreshAndSelectCreatedProject(
  projectId: string,
  reloadProjects: () => Promise<void>,
  setCurrentProjectId: (projectId: string) => void,
  onError: (error: unknown) => void,
): Promise<void> {
  try {
    await reloadProjects();
    setCurrentProjectId(projectId);
  } catch (error) {
    onError(error);
  }
}
