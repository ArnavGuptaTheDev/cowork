// All user-facing copy lives here so wording can be changed without touching components.
export const copy = {
  appName: 'CoWork',
  tagline: 'Two people, two lists, one rhythm.',
  landing: {
    title: 'Do the work. <em>Together.</em>',
    lede: 'Projects, todos and habits for the two of you. Your own lists, each other\'s progress, and a nudge when it matters.',
    signIn: 'Continue with Google',
    inviteOnly: 'CoWork is invite-only. Ask the admin to add your email.',
    errors: {
      cancelled: 'Sign-in was cancelled.',
      expired: 'That sign-in attempt expired. Please try again.',
      google: "We couldn't verify your Google account. Please try again.",
    } as Record<string, string>,
  },
  notInvited: {
    title: 'You\'re not on the list (yet)',
    body: 'CoWork is private and invite-only. Your Google account signed in fine, but this email hasn\'t been invited. No account was created.',
    unverified: 'Your Google email address isn\'t verified, so we can\'t let you in.',
    cta: 'Try a different account',
  },
  nav: { today: 'Today', week: 'Week', projects: 'Projects', habits: 'Habits', partner: 'Partner' },
  today: {
    eyebrowSelf: 'Your day',
    empty: { title: 'A clear day', body: 'Nothing due today. Add something, or enjoy the quiet.' },
    allDone: 'Everything done. Nicely played.',
    carried: 'Carried over',
    add: 'Add a todo',
  },
  partner: {
    none: {
      title: 'Better together',
      body: 'Pair with your partner to see each other\'s day, projects and streaks.',
      cta: 'Pair up in Settings',
    },
    readOnly: 'View only. These are their lists.',
    suggest: 'Suggest a todo',
  },
  habits: {
    empty: { title: 'No habits yet', body: 'Make a todo repeat (daily, weekly or monthly) and it shows up here with a streak.' },
  },
  projects: {
    empty: { title: 'No projects yet', body: 'Group todos into projects like "Portfolio site" or "Q4 launch" and watch the progress bar fill.' },
  },
  suggestions: {
    emptyIn: 'No suggestions waiting for you.',
    emptyOut: "You haven't suggested anything yet.",
  },
  privateHint: 'Private todos are hidden from your partner, photos included.',
} as const;
