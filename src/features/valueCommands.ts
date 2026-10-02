/** The value commands of the palette and the editor menus (Show Value, Auto Log, copy, hover links, package install), registered by extension.ts. */
import type { LiveValues } from './liveValues';
import type { PackageInstall } from './packageInstall';

export function registerValueCommands(reg: (id: string, fn: (...args: unknown[]) => unknown) => void, liveValues: LiveValues, packages: PackageInstall): void {
  reg('pyokka.showValue', () => liveValues.showValue());
  reg('pyokka.showLineValues', () => liveValues.showLineValues());
  reg('pyokka.showLineTimings', () => liveValues.showLineTimings());
  reg('pyokka.copyValue', () => liveValues.copyValue());
  reg('pyokka.clearValue', () => liveValues.clearValue());
  reg('pyokka.clearFileValues', () => liveValues.clearFileValues());
  reg('pyokka.enableShowValueOnSelection', () => liveValues.setShowValueOnSelection(true));
  reg('pyokka.disableShowValueOnSelection', () => liveValues.setShowValueOnSelection(false));
  reg('pyokka.enableShowSingleInlineValue', () => liveValues.setShowSingleInlineValue(true));
  reg('pyokka.disableShowSingleInlineValue', () => liveValues.setShowSingleInlineValue(false));
  reg('pyokka.enableAutoLog', () => liveValues.setAutoLog(true));
  reg('pyokka.disableAutoLog', () => liveValues.setAutoLog(false));
  reg('pyokka.copyExpressionPath', (arg) => liveValues.copyExpressionPath(arg));
  reg('pyokka.copyExpressionData', (arg) => liveValues.copyExpressionData(arg));
  reg('pyokka.hoverCopy', (arg) => liveValues.hoverCopy(arg));
  reg('pyokka.exploreEntity', (arg) => liveValues.exploreEntity(arg));
  reg('pyokka.installMissingPackageToProject', (arg) => packages.installToProject(arg));
  reg('pyokka.installMissingPackageForFile', (arg) => packages.installForFile(arg));
}
