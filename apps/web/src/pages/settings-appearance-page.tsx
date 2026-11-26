import { AppearanceSettings } from "@/components/appearance-settings";
import { PageHeader } from "@/components/page-header";

/** Colour theme and light or dark. Both are kept on this device only. */
export function SettingsAppearancePage() {
  return (
    <div className="animate-fade-up">
      <PageHeader
        eyebrow="Settings"
        title="Appearance"
        description="How Housetory looks on this device. Other people and your other devices are not changed."
        backTo="/settings"
        backLabel="Settings"
      />
      <section className="surface max-w-4xl p-5 sm:p-6">
        <AppearanceSettings />
      </section>
    </div>
  );
}
