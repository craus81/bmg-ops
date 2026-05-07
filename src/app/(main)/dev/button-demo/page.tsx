'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { ButtonShadcn } from '@/components/ui/ButtonShadcn';
import { theme } from '@/lib/theme';

/**
 * Side-by-side preview of the two Button options for the design-system
 * decision. Lives under /dev so it's gated by the same auth as the rest
 * of the app but isn't linked from any nav. Visit /dev/button-demo.
 */
export default function ButtonDemoPage() {
  const [loadingA, setLoadingA] = useState(false);
  const [loadingB, setLoadingB] = useState(false);

  const fakeAction = (setter: (b: boolean) => void) => {
    setter(true);
    setTimeout(() => setter(false), 1500);
  };

  return (
    <div style={{ maxWidth: '1100px', margin: '0 auto', padding: '12px 0 80px' }}>
      <h1 style={{ fontSize: '24px', fontWeight: 800, color: theme.textPrimary, marginBottom: '6px' }}>
        Button: Custom vs. shadcn-style
      </h1>
      <p style={{ fontSize: '14px', color: theme.textMuted, marginBottom: '28px', lineHeight: 1.6 }}>
        Two takes on the same component. The left column matches FleetSuite&apos;s existing
        bold/branded look. The right column approximates shadcn/ui&apos;s default aesthetic
        (neutral, subtle). Hover and click both to compare. Choosing &ldquo;shadcn&rdquo; for real
        would mean adding Tailwind to the project.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px' }}>
        <DemoColumn
          title="Custom (matches FleetSuite today)"
          subtitle="Bold, branded. Uses the orange/navy theme already in the app. No new dependencies."
          accent={theme.orange}
        >
          <Group label="Variants">
            <Button>Primary</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="destructive">Destructive</Button>
            <Button variant="ghost">Ghost</Button>
          </Group>
          <Group label="Sizes">
            <Button size="sm">Small</Button>
            <Button size="md">Medium</Button>
            <Button size="lg">Large</Button>
          </Group>
          <Group label="States">
            <Button disabled>Disabled</Button>
            <Button loading={loadingA} onClick={() => fakeAction(setLoadingA)}>
              {loadingA ? 'Saving…' : 'Click for loading'}
            </Button>
            <Button variant="secondary" loading={loadingA}>Secondary loading</Button>
          </Group>
          <Group label="Full width">
            <Button fullWidth>Save changes</Button>
          </Group>
        </DemoColumn>

        <DemoColumn
          title="shadcn-style (industry default)"
          subtitle="Neutral, restrained. Recognizable to most React devs. Would require adopting Tailwind."
          accent="#0a0a0a"
        >
          <Group label="Variants">
            <ButtonShadcn>Default</ButtonShadcn>
            <ButtonShadcn variant="secondary">Secondary</ButtonShadcn>
            <ButtonShadcn variant="destructive">Destructive</ButtonShadcn>
            <ButtonShadcn variant="outline">Outline</ButtonShadcn>
            <ButtonShadcn variant="ghost">Ghost</ButtonShadcn>
          </Group>
          <Group label="Sizes">
            <ButtonShadcn size="sm">Small</ButtonShadcn>
            <ButtonShadcn size="md">Medium</ButtonShadcn>
            <ButtonShadcn size="lg">Large</ButtonShadcn>
          </Group>
          <Group label="States">
            <ButtonShadcn disabled>Disabled</ButtonShadcn>
            <ButtonShadcn loading={loadingB} onClick={() => fakeAction(setLoadingB)}>
              {loadingB ? 'Saving…' : 'Click for loading'}
            </ButtonShadcn>
            <ButtonShadcn variant="secondary" loading={loadingB}>Secondary loading</ButtonShadcn>
          </Group>
          <Group label="Full width">
            <ButtonShadcn fullWidth>Save changes</ButtonShadcn>
          </Group>
        </DemoColumn>
      </div>

      <div
        style={{
          marginTop: '40px',
          padding: '20px',
          background: theme.card,
          border: `1px solid ${theme.border}`,
          borderRadius: '12px',
        }}
      >
        <div style={{ fontSize: '13px', fontWeight: 700, color: theme.textPrimary, marginBottom: '10px' }}>
          Tradeoffs at a glance
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', fontSize: '13px', color: theme.textSecondary, lineHeight: 1.7 }}>
          <div>
            <strong style={{ color: theme.orange }}>Custom</strong>
            <ul style={{ paddingLeft: '18px', marginTop: '6px' }}>
              <li>Matches the brand FleetSuite already has</li>
              <li>No new tooling or dependencies</li>
              <li>Adapts to the dark/light theme already wired up</li>
              <li>You own the design — tweak as needed</li>
              <li>Slower to build out the full kit (~10 components)</li>
            </ul>
          </div>
          <div>
            <strong style={{ color: theme.textPrimary }}>shadcn-style</strong>
            <ul style={{ paddingLeft: '18px', marginTop: '6px' }}>
              <li>Battle-tested, used by thousands of apps</li>
              <li>Familiar to most React developers</li>
              <li>Free, copy-paste components from shadcn-ui.com</li>
              <li>Requires adding Tailwind to the project</li>
              <li>Default aesthetic doesn&apos;t match FleetSuite&apos;s brand without theming work</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}

function DemoColumn({
  title,
  subtitle,
  accent,
  children,
}: {
  title: string;
  subtitle: string;
  accent: string;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        background: theme.card,
        border: `1px solid ${theme.border}`,
        borderRadius: '14px',
        padding: '20px',
      }}
    >
      <div style={{ borderLeft: `3px solid ${accent}`, paddingLeft: '12px', marginBottom: '20px' }}>
        <div style={{ fontSize: '15px', fontWeight: 700, color: theme.textPrimary }}>{title}</div>
        <div style={{ fontSize: '12px', color: theme.textMuted, marginTop: '4px', lineHeight: 1.5 }}>
          {subtitle}
        </div>
      </div>
      {children}
    </div>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: '20px' }}>
      <div
        style={{
          fontSize: '10px',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          fontWeight: 700,
          color: theme.textMuted,
          marginBottom: '10px',
        }}
      >
        {label}
      </div>
      <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>{children}</div>
    </div>
  );
}
