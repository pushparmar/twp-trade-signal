/**
 * LoginPage — dummy login gate.
 *
 * Credentials are fixed: user = "twp", password = "twp123".
 * On success the flag `twp_auth` is stored in localStorage so the
 * session survives a page refresh. The parent (App) removes that
 * flag when the user clicks "Sign out".
 */
import { useState } from 'react';
import styles from './LoginPage.module.css';

// ── Hardcoded credentials ──────────────────────────────────────────────────────
const VALID_USER     = 'twp';
const VALID_PASSWORD = 'twp123';

export default function LoginPage({ onLogin }) {
  const [username, setUsername]   = useState('');
  const [password, setPassword]   = useState('');
  const [showPass, setShowPass]   = useState(false);
  const [error,    setError]      = useState('');
  const [shaking,  setShaking]    = useState(false);

  function handleSubmit(e) {
    e.preventDefault();
    setError('');

    if (username.trim() === VALID_USER && password === VALID_PASSWORD) {
      // Persist across refreshes
      localStorage.setItem('twp_auth', '1');
      onLogin();
    } else {
      // Shake the card and show an error message
      setShaking(true);
      setError('Invalid username or password.');
      setTimeout(() => setShaking(false), 600);
    }
  }

  return (
    <div className={styles.backdrop}>
      <form
        className={`${styles.card} ${shaking ? styles.shake : ''}`}
        onSubmit={handleSubmit}
        noValidate
      >
        {/* Logo / title */}
        <div className={styles.logo}>
          <span className={styles.logoMark}>TWP</span>
        </div>
        <h1 className={styles.title}>Trading Dashboard</h1>
        <p className={styles.subtitle}>Sign in to continue</p>

        {/* Error banner */}
        {error && <p className={styles.errorBanner}>{error}</p>}

        {/* Username */}
        <label className={styles.label} htmlFor="twp-username">
          Username
        </label>
        <input
          id="twp-username"
          className={styles.input}
          type="text"
          autoComplete="username"
          autoFocus
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="Enter username"
        />

        {/* Password */}
        <label className={styles.label} htmlFor="twp-password">
          Password
        </label>
        <div className={styles.passwordWrap}>
          <input
            id="twp-password"
            className={styles.input}
            type={showPass ? 'text' : 'password'}
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Enter password"
          />
          <button
            type="button"
            className={styles.eyeBtn}
            onClick={() => setShowPass((v) => !v)}
            aria-label={showPass ? 'Hide password' : 'Show password'}
          >
            {showPass ? '🙈' : '👁️'}
          </button>
        </div>

        {/* Submit */}
        <button
          type="submit"
          className={styles.submitBtn}
          disabled={!username || !password}
        >
          Sign In
        </button>
      </form>
    </div>
  );
}
