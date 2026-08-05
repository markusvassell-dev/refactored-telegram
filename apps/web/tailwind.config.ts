import type { Config } from 'tailwindcss';

export default {
  content: ['./src/**/*.{ts,tsx}', '../../packages/ui/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#f2f7f4',
          100: '#e2ede6',
          500: '#4a7c62',
          600: '#3c6650',
          700: '#2f503f',
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
