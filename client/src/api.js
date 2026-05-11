import axios from 'axios';

// In production (Vercel), VITE_API_URL points to the Railway server.
// In development the Vite proxy forwards /api → localhost:3001.
const baseURL = import.meta.env.VITE_API_URL
  ? `${import.meta.env.VITE_API_URL}/api`
  : '/api';

const api = axios.create({ baseURL });

export default api;
