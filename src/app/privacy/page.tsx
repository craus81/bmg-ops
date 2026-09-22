import type { Metadata } from 'next';
import LegalPage, { contactBlock, type LegalSection } from '@/components/legal/LegalPage';
import { LEGAL } from '@/lib/legal';

export const metadata: Metadata = { title: 'Privacy Policy — BMG FleetSuite' };

const sections: LegalSection[] = [
  {
    heading: 'Information we collect',
    body: [[
      'Account information: names, work email addresses, phone numbers, and role information for BMG staff and invited users.',
      'Customer and business information: company names, contacts, billing and shipping addresses, vehicle details (VIN, unit numbers, specifications), quotes, estimates, work orders, invoices, and payment history.',
      'Credit application information: business identifiers such as EIN or tax ID, trade and bank references, and related details you submit when applying for credit terms.',
      'Photos and files: vehicle photos, proofs, designs, signatures, and documents uploaded to or generated in the Service.',
      'Communications: emails and text messages sent or received through the Service, including approval and notification messages.',
      "Accounting data: when BMG connects its own accounting systems (Oracle NetSuite and Intuit QuickBooks Online), the Service reads BMG's customers, transactions, and financial reports from those systems. The Service does not store full card numbers, CVV codes, or bank account and routing numbers from those systems.",
      'Device and usage information: log data, device type, browser, IP address, and, in the mobile app, camera access (for photos and scanning) and push-notification tokens, only when you grant permission.',
    ]],
  },
  {
    heading: 'How we use information',
    body: [
      'We use information to operate the Service. That includes preparing quotes and invoices, scheduling and performing work, communicating with customers, evaluating credit applications, keeping accounting records, securing the Service, and meeting legal obligations. We do not sell personal information, and we do not use it for third-party advertising.',
    ],
  },
  {
    heading: 'Service providers',
    body: [
      'We share information only with providers that help us run the Service, under agreements that limit their use of it. These include hosting and database (Vercel, Supabase), file storage (Cloudflare), email delivery (Resend, Mailchimp), text messaging (Twilio), accounting systems (Oracle NetSuite, Intuit QuickBooks Online), Google Workspace, and AI features (Anthropic), which process text and images to help BMG staff with tasks such as drafting and document review. We may also disclose information when the law requires it, or to protect the rights and safety of BMG, our customers, or others.',
    ],
  },
  {
    heading: 'QuickBooks data',
    body: [
      "If BMG connects QuickBooks Online, the Service uses Intuit's authorized connection to read BMG's own company data, for BMG's internal record-keeping only. We do not share QuickBooks data with third parties except the service providers above. BMG can disconnect at any time from the Service's settings, which revokes access at Intuit.",
    ],
  },
  {
    heading: 'Retention',
    body: ['We keep information for as long as we need it to provide the Service, keep business and tax records, resolve disputes, and meet legal obligations. After that, we delete or de-identify it.'],
  },
  {
    heading: 'Security',
    body: ['We use encryption in transit, access controls based on role, restricted file storage, and audit logging. No system is perfectly secure, and we cannot guarantee absolute security.'],
  },
  {
    heading: 'Your choices',
    body: ['You can ask to see, correct, or delete your personal information by contacting us at the address below. Some information must be kept for accounting or legal reasons. You can opt out of non-essential text messages by replying STOP.'],
  },
  {
    heading: 'Children',
    body: ['The Service is for businesses and is not directed to anyone under 16.'],
  },
  {
    heading: 'Changes',
    body: ['We may update this policy and will post the new version with a new effective date.'],
  },
  {
    heading: 'Contact',
    body: contactBlock(LEGAL.privacyEmail),
  },
];

export default function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy Policy"
      intro={`This Privacy Policy explains how ${LEGAL.entityName} ("BMG," "we," "us") collects, uses, and protects information in FleetSuite, our internal operations application at go.bmgfleet.com and its mobile apps (the "Service"). FleetSuite supports BMG's vehicle upfit, graphics, scheduling, estimating, and invoicing work. It is used by BMG staff and by BMG customers who receive quotes, approvals, booking links, and portal links from us.`}
      sections={sections}
    />
  );
}
