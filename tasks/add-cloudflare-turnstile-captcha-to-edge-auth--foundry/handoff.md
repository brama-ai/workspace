# Pipeline Handoff

- **Task**: <!-- priority: 2 -->
# Add Cloudflare Turnstile CAPTCHA to Edge Authentication

Integrate Cloudflare Turnstile (CAPTCHA) into the edge authentication login form to protect admin interfaces from brute-force attacks.

## Goal

Add Cloudflare Turnstile verification to the edge auth login flow to prevent automated attacks while maintaining good user experience.

## Context

### Current Edge Authentication Flow

**Login endpoint:** `brama-core/src/src/Controller/EdgeAuth/LoginController.php:33`
**Login template:** `brama-core/templates/edge_auth/login.html.twig` (referenced at line 46)

**Current flow:**
1. User visits protected service (e.g., `langfuse.localhost`)
2. No valid JWT token → redirect to `/edge/auth/login?rd=<original-url>`
3. User enters username + password
4. POST to `/edge/auth/login` with `_username`, `_password`, `rd`
5. Validate credentials (lines 53-72)
6. Create JWT token, set cookie, redirect to original URL (line 74)

**No CAPTCHA protection** → vulnerable to brute-force attacks on admin credentials.

### What is Cloudflare Turnstile?

**Cloudflare Turnstile** is a user-friendly CAPTCHA alternative:
- Free tier: 1M verifications/month
- Privacy-focused (no tracking)
- Better UX than reCAPTCHA
- Simple integration

**Docs:** https://developers.cloudflare.com/turnstile/

### How Turnstile Works

1. **Frontend:** Add Turnstile widget to HTML form
2. **User interaction:** Cloudflare runs invisible/visible challenge
3. **Form submission:** Include `cf-turnstile-response` token
4. **Backend verification:** POST token to Cloudflare API
5. **API response:** Success/failure validation

## Implementation Plan

### Step 1: Register Turnstile Site

**Manual step (document in guide):**

1. Go to https://dash.cloudflare.com/
2. Navigate to "Turnstile" section
3. Click "Add Site"
4. Configure:
   - **Domain:** `localhost` (for dev), `*.46.62.135.86.nip.io` (for production)
   - **Widget mode:** Managed (recommended)
5. Save and get:
   - **Site Key** (public, goes in frontend)
   - **Secret Key** (private, goes in backend)

### Step 2: Add Environment Variables

**Update `.env.deployment.example`:**

```bash
# ---------------------------------------------------------------------------
# Cloudflare Turnstile Configuration
# ---------------------------------------------------------------------------
# Get keys from: https://dash.cloudflare.com/ → Turnstile
TURNSTILE_SITE_KEY=1x00000000000000000000AA  # Example dev key
TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA  # Example dev key
TURNSTILE_ENABLED=true  # Set to false to disable in development
```

**Note:** Cloudflare provides test keys for development:
- **Site key:** `1x00000000000000000000AA` (always passes)
- **Secret key:** `1x0000000000000000000000000000000AA` (always passes)

### Step 3: Update Login Template

**File:** `brama-core/templates/edge_auth/login.html.twig`

**Add Turnstile script in `<head>`:**
```twig
<head>
    {# ... existing meta tags ... #}

    {% if turnstile_enabled %}
    <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
    {% endif %}
</head>
```

**Add Turnstile widget before submit button:**
```twig
<form method="post" action="{{ path('edge_auth_login') }}">
    {# ... existing username/password fields ... #}

    {% if turnstile_enabled %}
    <div class="cf-turnstile"
         data-sitekey="{{ turnstile_site_key }}"
         data-theme="light"
         data-size="normal">
    </div>
    {% endif %}

    <button type="submit">Увійти</button>
</form>
```

### Step 4: Update LoginController

**File:** `brama-core/src/src/Controller/EdgeAuth/LoginController.php`

**Add constructor parameters:**
```php
public function __construct(
    private readonly UserProvider $userProvider,
    private readonly UserPasswordHasherInterface $passwordHasher,
    private readonly EdgeJwtService $jwtService,
    private readonly string $cookieName,
    private readonly int $tokenTtlSeconds,
    private readonly bool $turnstileEnabled,        // NEW
    private readonly string $turnstileSiteKey,      // NEW
    private readonly string $turnstileSecretKey,    // NEW
) {
}
```

**Add Turnstile verification before password check:**
```php
public function __invoke(Request $request, #[CurrentUser] ?User $currentUser): Response
{
    // ... existing GET logic ...

    if (!$request->isMethod('POST')) {
        return $this->render('edge_auth/login.html.twig', [
            'rd' => $redirectTarget,
            'error' => null,
            'last_username' => '',
            'turnstile_enabled' => $this->turnstileEnabled,    // NEW
            'turnstile_site_key' => $this->turnstileSiteKey,   // NEW
        ]);
    }

    // ... existing username/password extraction ...

    // NEW: Verify Turnstile BEFORE checking password
    if ($this->turnstileEnabled && !$this->verifyTurnstile($request)) {
        return $this->render('edge_auth/login.html.twig', [
            'rd' => $redirectTarget,
            'error' => 'Не вдалося пройти перевірку CAPTCHA. Спробуйте ще раз.',
            'last_username' => $username,
            'turnstile_enabled' => $this->turnstileEnabled,
            'turnstile_site_key' => $this->turnstileSiteKey,
        ], new Response('', Response::HTTP_UNAUTHORIZED));
    }

    // ... existing password validation ...
}

private function verifyTurnstile(Request $request): bool
{
    $token = (string) $request->request->get('cf-turnstile-response', '');

    if ('' === $token) {
        return false;
    }

    $response = file_get_contents('https://challenges.cloudflare.com/turnstile/v0/siteverify', false, stream_context_create([
        'http' => [
            'method' => 'POST',
            'header' => 'Content-Type: application/x-www-form-urlencoded',
            'content' => http_build_query([
                'secret' => $this->turnstileSecretKey,
                'response' => $token,
                'remoteip' => $request->getClientIp(),
            ]),
        ],
    ]));

    if (false === $response) {
        return false;
    }

    $data = json_decode($response, true);

    return is_array($data) && ($data['success'] ?? false);
}
```

**Better approach (using Symfony HttpClient):**

Add dependency injection for `HttpClientInterface`:
```php
use Symfony\Contracts\HttpClient\HttpClientInterface;

public function __construct(
    // ... existing params ...
    private readonly HttpClientInterface $httpClient,  // NEW
) {}

private function verifyTurnstile(Request $request): bool
{
    $token = (string) $request->request->get('cf-turnstile-response', '');

    if ('' === $token) {
        return false;
    }

    try {
        $response = $this->httpClient->request('POST', 'https://challenges.cloudflare.com/turnstile/v0/siteverify', [
            'body' => [
                'secret' => $this->turnstileSecretKey,
                'response' => $token,
                'remoteip' => $request->getClientIp(),
            ],
        ]);

        $data = $response->toArray();

        return $data['success'] ?? false;
    } catch (\Exception) {
        return false;  // Fail closed on errors
    }
}
```

### Step 5: Configure Services

**File:** `brama-core/src/config/services.yaml`

Add parameters:
```yaml
parameters:
    env(TURNSTILE_ENABLED): 'false'
    env(TURNSTILE_SITE_KEY): ''
    env(TURNSTILE_SECRET_KEY): ''

    turnstile.enabled: '%env(bool:TURNSTILE_ENABLED)%'
    turnstile.site_key: '%env(TURNSTILE_SITE_KEY)%'
    turnstile.secret_key: '%env(TURNSTILE_SECRET_KEY)%'

services:
    App\Controller\EdgeAuth\LoginController:
        arguments:
            $turnstileEnabled: '%turnstile.enabled%'
            $turnstileSiteKey: '%turnstile.site_key%'
            $turnstileSecretKey: '%turnstile.secret_key%'
```

### Step 6: Update Kubernetes Secrets

**For K3S deployment**, add to secrets:

```bash
# Create/update brama-core-secrets
kubectl create secret generic brama-core-secrets \
  --from-literal=TURNSTILE_ENABLED=true \
  --from-literal=TURNSTILE_SITE_KEY=<your-site-key> \
  --from-literal=TURNSTILE_SECRET_KEY=<your-secret-key> \
  --dry-run=client -o yaml | kubectl apply -f -
```

**Update Helm values** to reference secret:

```yaml
core:
  env:
    TURNSTILE_ENABLED: "true"
  secretRef: brama-core-secrets  # Contains TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY
```

### Step 7: Create Setup Documentation

**File:** `docs/security/cloudflare-turnstile-setup.md`

Include:
- Step-by-step Cloudflare dashboard walkthrough with screenshots
- Development vs Production key differences
- Environment variable configuration
- Testing instructions
- Troubleshooting common issues

**Template for docs:**

```markdown
# Cloudflare Turnstile Setup Guide

## What is Turnstile?

Cloudflare Turnstile is a CAPTCHA alternative that protects login forms from automated attacks.

## Setup Steps

### 1. Create Turnstile Site

1. Log in to [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. Navigate to **Turnstile** in the sidebar
3. Click **Add Site**
4. Fill in:
   - **Site name:** Brama Platform - Production
   - **Domain:** `*.46.62.135.86.nip.io` (or your real domain)
   - **Widget mode:** Managed (recommended)
5. Click **Create**
6. Copy the **Site Key** and **Secret Key**

### 2. Configure Environment Variables

**Local development (.env.deployment):**
```bash
TURNSTILE_ENABLED=true
TURNSTILE_SITE_KEY=1x00000000000000000000AA  # Test key (always passes)
TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA
```

**Production (Kubernetes secret):**
```bash
kubectl create secret generic brama-core-secrets \
  --from-literal=TURNSTILE_SITE_KEY=<real-site-key> \
  --from-literal=TURNSTILE_SECRET_KEY=<real-secret-key> \
  -n brama
```

### 3. Verify Setup

1. Navigate to login page: `http://localhost/edge/auth/login`
2. You should see Turnstile widget below password field
3. Try logging in:
   - ✅ Widget solved → login works
   - ❌ Widget not solved → error message shown

### 4. Troubleshooting

**Widget not showing:**
- Check browser console for errors
- Verify `TURNSTILE_ENABLED=true`
- Check `TURNSTILE_SITE_KEY` is set correctly

**Always failing verification:**
- Verify `TURNSTILE_SECRET_KEY` matches site
- Check server can reach `challenges.cloudflare.com`
- Review Cloudflare dashboard for failed verification logs

**Rate limiting:**
- Free tier: 1M verifications/month
- Upgrade plan if hitting limits
```

## Files to Create/Modify

### Create:
1. `docs/security/cloudflare-turnstile-setup.md` - Setup guide

### Modify:
1. `brama-core/src/src/Controller/EdgeAuth/LoginController.php` - Add Turnstile verification
2. `brama-core/templates/edge_auth/login.html.twig` - Add Turnstile widget
3. `brama-core/src/config/services.yaml` - Add Turnstile parameters
4. `.env.deployment.example` - Add Turnstile environment variables
5. `brama-core/deploy/charts/brama/values-prod.example.yaml` - Document Turnstile in comments

### Test:
1. `brama-core/tests/Functional/EdgeAuth/LoginControllerTest.php` - Add Turnstile tests
2. `brama-core/tests/e2e/tests/admin/edge_auth_test.js` - Update E2E tests

## Validation Checklist

### Development (Docker Compose)
- [ ] Environment variables added to `.env.deployment.example`
- [ ] Turnstile widget visible on login page at `http://localhost/edge/auth/login`
- [ ] With `TURNSTILE_ENABLED=false`, login works without widget
- [ ] With `TURNSTILE_ENABLED=true` and test keys, login works with widget
- [ ] Invalid Turnstile response shows error message
- [ ] E2E tests updated to handle Turnstile (or mock it)

### Production (K3S)
- [ ] Real Turnstile site created in Cloudflare dashboard
- [ ] Kubernetes secret contains `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY`
- [ ] Widget visible on production login page
- [ ] Login works with valid Turnstile verification
- [ ] Failed Turnstile verification blocks login
- [ ] Documentation created in `docs/security/cloudflare-turnstile-setup.md`

### Security
- [ ] Secret key never logged or exposed in responses
- [ ] Verification happens server-side (not just client-side)
- [ ] Failed verification returns 401 Unauthorized
- [ ] Rate limiting considered (Cloudflare handles this)
- [ ] IP address passed to Turnstile for better fraud detection

## Testing Strategy

### Unit Tests

**File:** `brama-core/tests/Unit/EdgeAuth/TurnstileVerifierTest.php` (if extracted to service)

Test cases:
- Valid token → verification passes
- Invalid token → verification fails
- Empty token → verification fails
- Network error → verification fails (fail closed)

### Functional Tests

**File:** `brama-core/tests/Functional/EdgeAuth/LoginControllerTest.php`

Test cases:
- Login with `TURNSTILE_ENABLED=false` → works normally
- Login with `TURNSTILE_ENABLED=true` and missing token → fails with CAPTCHA error
- Login with `TURNSTILE_ENABLED=true` and valid mock token → works

**Mock Turnstile API in tests:**
```php
// Use Symfony HttpClient mock to simulate Turnstile responses
$this->httpClient->expects($this->once())
    ->method('request')
    ->willReturn(new MockResponse(json_encode(['success' => true])));
```

### E2E Tests

**File:** `brama-core/tests/e2e/tests/admin/edge_auth_test.js`

**Strategy:** Disable Turnstile in E2E tests OR use test keys:
```javascript
// In E2E environment, set:
process.env.TURNSTILE_ENABLED = 'false';

// OR use test keys that always pass
process.env.TURNSTILE_SITE_KEY = '1x00000000000000000000AA';
```

## References

### Cloudflare Turnstile Documentation
- Main docs: https://developers.cloudflare.com/turnstile/
- API reference: https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
- Test keys: https://developers.cloudflare.com/turnstile/reference/testing/

### Implementation References
- Current login controller: `brama-core/src/src/Controller/EdgeAuth/LoginController.php`
- Current login template: `brama-core/templates/edge_auth/login.html.twig` (referenced)
- Edge auth config: `.env.deployment.example:92-96`

### Similar Implementations
- reCAPTCHA v3 integration examples
- Symfony form CSRF protection (similar pattern)

## Security Considerations

### Attack Vectors Protected
- ✅ **Brute-force login attempts** - Turnstile rate limits automated requests
- ✅ **Credential stuffing** - Makes automation significantly harder
- ✅ **Bot traffic** - Cloudflare's bot detection

### Attack Vectors NOT Protected
- ❌ **Password reset attacks** - Need separate rate limiting
- ❌ **Account enumeration** - Need consistent error messages
- ❌ **Session fixation** - Already protected by JWT implementation

### Additional Hardening (Future Tasks)
- Add rate limiting per IP (e.g., max 5 login attempts per 15 minutes)
- Add account lockout after N failed attempts
- Add 2FA for admin accounts
- Monitor failed login attempts in logs

## Success Criteria

1. ✅ Turnstile widget integrated into login form
2. ✅ Server-side verification implemented correctly
3. ✅ Environment variables configured for dev and production
4. ✅ Documentation created with setup instructions
5. ✅ Tests updated to handle Turnstile (disabled or mocked)
6. ✅ Login flow works in both local and production environments
7. ✅ Brute-force attacks significantly harder to execute
8. ✅ User experience remains smooth (invisible/managed mode)

## Notes

- **Performance:** Turnstile verification adds ~100-300ms to login time
- **Privacy:** Turnstile is more privacy-friendly than reCAPTCHA (no Google tracking)
- **Accessibility:** Managed mode provides accessible alternatives automatically
- **Fallback:** Consider disabling Turnstile if Cloudflare API is unreachable (configurable via `TURNSTILE_ENABLED`)
- **Started**: 2026-03-25 17:42:35
- **Branch**: pipeline/add-cloudflare-turnstile-captcha-to-edge-auth
- **Pipeline ID**: 20260325_174233

---

## Architect

- **Status**: pending
- **Change ID**: —
- **Apps affected**: —
- **DB changes**: —
- **API changes**: —

## Coder

- **Status**: pending
- **Files modified**: —
- **Migrations created**: —
- **Deviations**: —

## Validator

- **Status**: pending
- **PHPStan**: —
- **CS-check**: —
- **Files fixed**: —

## Tester

- **Status**: pending
- **Test results**: —
- **New tests written**: —

## Auditor

- **Status**: pending
- **Verdict**: —
- **Recommendations**: —

## Documenter

- **Status**: pending
- **Docs created/updated**: —

## Summarizer

- **Status**: pending
- **Summary file**: —
- **Next task recommendation**: —

---

- **Commit (coder)**: 10b1c1d
