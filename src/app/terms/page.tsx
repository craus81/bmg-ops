import type { Metadata } from 'next';
import LegalPage, { contactBlock, type LegalSection } from '@/components/legal/LegalPage';
import { LEGAL } from '@/lib/legal';

export const metadata: Metadata = { title: 'End-User License Agreement — BMG FleetSuite' };

const sections: LegalSection[] = [
  {
    heading: 'License',
    body: ["BMG grants you a limited, non-exclusive, non-transferable, revocable license to use the Service for its intended purpose. For BMG staff, that means BMG's business operations. For customers, it means reviewing, approving, and managing work BMG performs for you."],
  },
  {
    heading: 'Accounts',
    body: ['Keep your login credentials confidential. You are responsible for activity under your account. Tell us promptly if you suspect unauthorized use.'],
  },
  {
    heading: 'Acceptable use',
    body: ['You will not:', [
      'copy, modify, reverse engineer, or resell the Service',
      'access data you are not authorized to see',
      "interfere with the Service's operation or security",
      'upload unlawful or infringing content',
      'use the Service to send spam',
    ]],
  },
  {
    heading: 'Third-party services',
    body: ['The Service connects to third-party services such as Intuit QuickBooks Online, Oracle NetSuite, and messaging providers. Your use of those services is governed by their own terms, and BMG is not responsible for them.'],
  },
  {
    heading: 'Your content',
    body: ['You keep ownership of the content you upload. You grant BMG a license to use it only as needed to provide the Service and perform the related work.'],
  },
  {
    heading: 'Ownership',
    body: ['BMG and its licensors own the Service and all related intellectual property. This Agreement does not transfer any ownership to you.'],
  },
  {
    heading: 'Approvals and signatures',
    body: ['Approvals, signatures, and acceptances you submit through the Service, such as quote and proof approvals, are binding as if signed in writing, to the extent the law allows.'],
  },
  {
    heading: 'Disclaimer',
    body: ['THE SERVICE IS PROVIDED "AS IS" AND "AS AVAILABLE," WITHOUT WARRANTIES OF ANY KIND, WHETHER EXPRESS OR IMPLIED, INCLUDING MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND NON-INFRINGEMENT.'],
  },
  {
    heading: 'Limitation of liability',
    body: ["TO THE EXTENT THE LAW ALLOWS, BMG IS NOT LIABLE FOR INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, OR FOR LOST PROFITS OR DATA. BMG'S TOTAL LIABILITY FOR ANY CLAIM RELATED TO THE SERVICE IS LIMITED TO THE GREATER OF $100 OR THE AMOUNT YOU PAID BMG FOR USE OF THE SERVICE IN THE 12 MONTHS BEFORE THE CLAIM. THIS LIMIT DOES NOT CHANGE WHAT YOU OWE FOR WORK BMG PERFORMS."],
  },
  {
    heading: 'Termination',
    body: ['BMG may suspend or end your access at any time. Sections 5 through 11 survive termination.'],
  },
  {
    heading: 'Governing law',
    body: [`The laws of the State of ${LEGAL.governingState} govern this Agreement. Any dispute will be resolved in the state or federal courts located in ${LEGAL.venue}.`],
  },
  {
    heading: 'Changes',
    body: ['We may update this Agreement. If you keep using the Service after an update, you accept the new terms.'],
  },
  {
    heading: 'Contact',
    body: contactBlock(LEGAL.contactEmail),
  },
];

export default function TermsPage() {
  return (
    <LegalPage
      title="End-User License Agreement"
      intro={`This End-User License Agreement ("Agreement") is between ${LEGAL.entityName} ("BMG") and you, the person or business using FleetSuite (the "Service"). By using the Service, you agree to this Agreement.`}
      sections={sections}
    />
  );
}
