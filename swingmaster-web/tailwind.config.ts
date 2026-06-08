import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        'brand': '#6366f1',        // indigo-500
        'brand-dark': '#4f46e5',   // indigo-600
      },
    },
  },
  plugins: [],
};

export default config;
