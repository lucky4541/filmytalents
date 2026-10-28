/** Default data used by the seed script and to reset demo data. */

export const PLANS = [
  { id: 'free', name: 'Free', tagline: 'Everything you need to get started', isFree: true, popular: false, order: 0, color: 'neutral', trialDays: 0,
    features: ['Profile with photo gallery', 'Browse all auditions', '5 applications a month', 'Follow & community posts'],
    limits: { applicationsPerMonth: 5, chat: false, postCastings: false, videoPosts: false, earlyAccess: false, whoViewed: false, boost: false },
    prices: [] as { cycle: 'MONTHLY' | 'QUARTERLY' | 'HALFYEARLY' | 'YEARLY'; price: number; enabled: boolean }[] },
  { id: 'pro', name: 'Pro', tagline: 'For working actors, models and dancers', isFree: false, popular: true, order: 1, color: 'gold', trialDays: 0,
    features: ['Unlimited applications', 'Post your own castings & auditions', 'Pro-only castings + early access', 'Chat with other members', 'Video posts & showreel', 'See who viewed your profile'],
    limits: { applicationsPerMonth: null, chat: true, postCastings: true, videoPosts: true, earlyAccess: true, whoViewed: true, boost: true },
    prices: [{ cycle: 'MONTHLY' as const, price: 9900, enabled: true }, { cycle: 'QUARTERLY' as const, price: 26900, enabled: true }, { cycle: 'HALFYEARLY' as const, price: 49900, enabled: false }, { cycle: 'YEARLY' as const, price: 99000, enabled: true }] },
];

export const PERM_MODULES = ['dashboard', 'castings', 'users', 'verification', 'moderation', 'payments', 'plans', 'engage', 'support', 'catalogue', 'team', 'settings', 'audit'];
export const ROLE_PERMS: Record<string, string[]> = {
  'Super Admin': PERM_MODULES,
  'Casting Manager': ['dashboard', 'castings', 'users', 'catalogue'],
  Moderator: ['dashboard', 'moderation', 'users'],
  'Verification Officer': ['dashboard', 'verification', 'users'],
  'Support Agent': ['dashboard', 'support', 'users'],
  'Content Manager': ['dashboard', 'engage', 'moderation'],
  Finance: ['dashboard', 'payments', 'plans', 'audit', 'settings'],
};

export const CATALOGUE: Record<string, string[]> = {
  crafts: ['Actor', 'Actress', 'Model', 'Dancer', 'Singer', 'Anchor', 'Child Artist', 'Voice Artist', 'Influencer', 'Theatre Artist', 'Stand-up Comedian', 'Musician'],
  projectTypes: ['Feature Film', 'Web Series', 'Short Film', 'TV Serial', 'Ad / Campaign', 'Music Video', 'Theatre', 'Event / Anchoring', 'Modelling / Print'],
  languages: ['Telugu', 'Hindi', 'Tamil', 'Kannada', 'Malayalam', 'English', 'Bengali', 'Marathi', 'Gujarati', 'Punjabi'],
  cities: ['Hyderabad', 'Mumbai', 'Chennai', 'Bengaluru', 'Delhi', 'Kolkata', 'Kochi', 'Pune', 'Visakhapatnam', 'Vijayawada', 'Ahmedabad', 'Jaipur'],
  reportReasons: ['Scam or fraud', 'Nudity or sexual content', 'Harassment or bullying', 'Impersonation', 'Spam', 'Child safety', 'Hate speech', 'Something else'],
  rejectReasons: ['Photo of ID is blurry', 'Name on ID does not match profile', 'Selfie does not match ID', 'Document expired', 'Guardian ID missing for minor'],
};

export const AUTO_RULES = [
  { key: 'casting_match', group: 'Castings', name: 'New casting matches profile', description: 'When a casting goes live, alert members whose craft, gender, age and city match a role.', channels: ['push', 'sms'], template: 'New audition for {role} in {city}. Apply before {deadline}!' },
  { key: 'deadline_reminder', group: 'Castings', name: 'Deadline reminder', description: 'Members who saved a casting but haven’t applied, 24 hours before it closes.', channels: ['push'], template: '{casting} closes tomorrow. Send your tape now.' },
  { key: 'shortlisted', group: 'Applications', name: 'Shortlisted', description: 'When a casting team shortlists an applicant.', channels: ['push', 'sms'], template: 'Good news! You are shortlisted for {role} in {casting}.' },
  { key: 'round2', group: 'Applications', name: 'Invited to round 2', description: 'Round 2 invite with date and venue.', channels: ['push', 'sms'], template: 'You are invited to round 2 for {role}. {date} at {venue}. Book your slot in the app.' },
  { key: 'selected', group: 'Applications', name: 'Selected', description: 'When an applicant is selected.', channels: ['push', 'sms'], template: 'Congratulations! You are selected for {role} in {casting}.' },
  { key: 'not_selected', group: 'Applications', name: 'Not selected', description: 'Polite update when the role is filled.', channels: ['push'], template: 'Thank you for applying to {casting}. The role has been filled. Keep going!' },
  { key: 'plan_expiring', group: 'Plans', name: 'Plan expiring soon', description: '3 days before a paid plan ends.', channels: ['push', 'sms'], template: 'Your {plan} plan ends on {date}. Renew to keep Pro features.' },
  { key: 'payment_receipt', group: 'Plans', name: 'Payment receipt', description: 'Invoice after every payment.', channels: ['push'], template: 'Payment of {amount} received. Invoice {invoice} is ready in My plan.' },
  { key: 'verification_result', group: 'Account', name: 'Verification result', description: 'When ID verification is approved or rejected.', channels: ['push', 'sms'], template: 'Your verification was {result}.' },
  { key: 'casting_review', group: 'Castings', name: 'Casting review result', description: 'When the team approves or rejects a casting posted by a member.', channels: ['push', 'sms'], template: 'Your casting “{casting}” was {result}.' },
];

export const CANNED = [
  { title: 'Greeting', text: 'Hi {name}, thanks for reaching out to FilmyTalents support! ' },
  { title: 'Ask for screenshot', text: 'Could you please share a screenshot of the screen where you see this? It will help us fix it faster.' },
  { title: 'Refund started', text: 'We have started your refund. It will reach your original payment method in 5–7 working days.' },
  { title: 'How to verify', text: 'Go to Get verified, upload a clear photo of your Aadhaar / PAN / Passport and a selfie. We review within 24 hours.' },
  { title: 'Never pay to audition', text: 'FilmyTalents never asks for money to audition. Please don’t pay anyone and report the profile. We will act on it right away.' },
  { title: 'Closing', text: 'I’m marking this as solved. Reply anytime if you need more help. Best of luck with your auditions!' },
];

export const SETTINGS: Record<string, unknown> = {
  general: { platformName: 'FilmyTalents', supportEmail: 'support@filmytalents.com', whatsapp: '+91 98765 43210', instagram: 'filmytalents', youtube: 'filmytalents' },
  uploads: { maxPhotoMb: 10, maxVideoMb: 50, maxVideoSec: 90, photosPerPost: 6 },
  features: { community: true, videoPosts: true, follows: true, chat: true, earlyAccess: true, signups: true, memberCastings: true },
  chat: { dailyLimit: 50, blockPhoneNumbers: true, blockedWords: 'registration fee, pay first, gpay, advance payment' },
  maintenance: { enabled: false, message: 'We are upgrading FilmyTalents. Back in 30 minutes.' },
  legal: { terms: 'By using FilmyTalents you agree to provide accurate information. Charging talent for auditions is prohibited.', privacy: 'We collect account details, profile information and uploads to run the platform. Phone numbers stay private.', refund: 'Pro subscriptions can be refunded within 7 days if no Pro-only castings were applied to.', childSafety: 'Profiles of minors are managed by a parent or guardian. Contact goes to the guardian only.' },
  payments: { primary: 'razorpay', fallback: true, razorpay: { enabled: true, mode: 'test', methods: { upi: true, card: true, netbanking: true, wallet: true } }, cashfree: { enabled: false, mode: 'test', methods: { upi: true, card: true, netbanking: true, wallet: false } }, business: { legalName: 'Filmy Trendz Media Pvt Ltd', gstin: '', invoicePrefix: 'CH-INV-', address: 'Hyderabad, Telangana', sac: '998439', state: 'Telangana' } },
  security: { sessionTimeoutMin: 60, ipAllowlist: '', loginAlerts: true },
  home: { hero: { title: 'Get seen. Get cast.', subtitle: 'Apply to film, OTT, TV and ad auditions with a video tape, free.', ctaLabel: 'Find auditions', joinLabel: 'Join now — it’s free', trustLine: 'Free forever plan · 2-minute sign-up · Never pay to audition', image: '' }, announcement: { enabled: true, text: 'Auditions are free to apply — never pay anyone to audition', link: '/safety', tone: 'gold' }, banners: [
    { id: 'bn1', title: 'Go Pro: unlimited applications', subtitle: 'Pro-only castings, member chat and video showreels.', image: 'https://images.pexels.com/photos/1190298/pexels-photo-1190298.jpeg?auto=compress&cs=tinysrgb&w=1600', ctaLabel: 'Get Pro', ctaLink: '/pricing', audience: 'free', active: true },
    { id: 'bn2', title: 'Get your verified badge', subtitle: 'Verified profiles get 3× more callbacks from casting teams.', image: 'https://images.pexels.com/photos/3812743/pexels-photo-3812743.jpeg?auto=compress&cs=tinysrgb&w=1600', ctaLabel: 'Verify now', ctaLink: '/verify', audience: 'all', active: true },
  ], sections: [], featuredCastings: [], featuredTalent: [], seo: { title: 'FilmyTalents — Where Talent Meets Opportunity', description: 'Discover auditions, showcase your work and get cast.' } },
};

export const COUPONS = [
  { code: 'DIWALI50', percent: 50, planIds: ['pro'], cycles: [] as ('MONTHLY' | 'QUARTERLY' | 'HALFYEARLY' | 'YEARLY')[], note: 'Diwali offer: 50% off' },
  { code: 'WELCOME20', percent: 20, planIds: ['pro'], cycles: ['MONTHLY' as const], note: '20% off your first month' },
  { code: 'YEARLY15', percent: 15, planIds: ['pro'], cycles: ['YEARLY' as const], note: 'Extra 15% off yearly' },
];
