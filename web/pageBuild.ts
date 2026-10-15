/** True when a bridge came back on another build: this tab's page code is stale, and replacing it loses nothing unsaved. */
export function staleBuild(known: string | undefined, incoming: string | undefined, dirty: boolean): boolean {
  return known !== undefined && incoming !== undefined && known !== incoming && !dirty;
}
