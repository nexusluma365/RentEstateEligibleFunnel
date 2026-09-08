const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const html = fs.readFileSync('rentready-review-checkout.html', 'utf8');
const script = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
  .map((match) => match[1])
  .find((code) => code.includes('createPrescreenIntent'));

if (!script) {
  throw new Error('Checkout inline script was not found');
}

function createElement(id) {
  const classes = new Set();
  return {
    id,
    value: '',
    textContent: '',
    innerHTML: '',
    disabled: true,
    listeners: {},
    classList: {
      add(name) {
        classes.add(name);
      },
      remove(name) {
        classes.delete(name);
      },
      toggle(name, force) {
        const shouldAdd = force === undefined ? !classes.has(name) : !!force;
        if (shouldAdd) classes.add(name);
        else classes.delete(name);
      },
      contains(name) {
        return classes.has(name);
      },
    },
    addEventListener(type, handler) {
      this.listeners[type] = handler;
    },
  };
}

async function waitFor(check, label) {
  for (let i = 0; i < 25; i += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function run() {
  const elementsById = {};
  [
    'paymentError',
    'summaryName',
    'summaryCity',
    'summaryMove',
    'summaryCredit',
    'payBtn',
    'cardNumber',
    'cardExpiry',
    'cardCvc',
    'billingZip',
    'billingName',
  ].forEach((id) => {
    elementsById[id] = createElement(id);
  });

  const storage = {
    rrn_answers_v1: JSON.stringify({
      lead_id: 'lead_123',
      email: 'test@example.com',
      first_name: 'Test',
      last_name: 'Applicant',
      preferred_city: 'High Point',
      move_timeline: 'flexible',
      credit_score: '620_659',
    }),
  };
  const mounted = [];
  const requests = [];
  const context = {
    console,
    document: {
      getElementById(id) {
        return elementsById[id] || null;
      },
    },
    sessionStorage: {
      getItem(key) {
        return storage[key] || null;
      },
      setItem(key, value) {
        storage[key] = value;
      },
    },
    localStorage: {
      getItem() {
        return null;
      },
    },
    window: {
      location: {
        href: '',
        replace(url) {
          this.href = url;
        },
      },
    },
    Stripe(key) {
      assert.equal(key, 'pk_test_mock');
      return {
        elements() {
          return {
            create(type) {
              return {
                mount(selector) {
                  mounted.push({ type, selector });
                },
                on() {},
              };
            },
          };
        },
        async confirmCardPayment(clientSecret, options) {
          assert.equal(clientSecret, 'pi_test_secret');
          assert.equal(options.payment_method.billing_details.name, 'Typed Name');
          assert.equal(options.payment_method.billing_details.address.postal_code, '12345');
          return { paymentIntent: { id: 'pi_test', status: 'succeeded' } };
        },
      };
    },
    fetch: async (url, options = {}) => {
      requests.push({ url, options });
      if (String(url).includes('get-entitlements')) {
        return { ok: true, json: async () => ({ ok: true, paid10: false }) };
      }
      if (String(url).includes('config')) {
        return { ok: true, json: async () => ({ ok: true, stripePublishableKey: 'pk_test_mock' }) };
      }
      if (String(url).includes('create-payment-intent')) {
        return {
          ok: true,
          json: async () => ({ ok: true, clientSecret: 'pi_test_secret', paymentIntentId: 'pi_test' }),
        };
      }
      if (String(url).includes('confirm-intent')) {
        return { ok: true, json: async () => ({ ok: true, status: 'succeeded' }) };
      }
      throw new Error(`Unexpected request: ${url}`);
    },
  };
  context.window.rrnTestContext = context;

  vm.createContext(context);
  vm.runInContext(script, context);

  await waitFor(() => mounted.length === 3 && elementsById.payBtn.disabled === false, 'card fields to mount');

  assert.deepEqual(
    mounted.map((entry) => entry.type),
    ['cardNumber', 'cardExpiry', 'cardCvc']
  );
  assert.equal(
    requests.some((request) => String(request.url).includes('create-payment-intent')),
    false,
    'PaymentIntent should not be created before the user clicks the CTA'
  );

  elementsById.billingName.value = 'Typed Name';
  elementsById.billingZip.value = '12345';
  await elementsById.payBtn.listeners.click();

  assert.equal(
    requests.some((request) => String(request.url).includes('create-payment-intent')),
    true,
    'PaymentIntent should be created when the user clicks the CTA'
  );
  assert.equal(
    JSON.parse(storage.rrn_flow_access_v1).step,
    'prescreen-results',
    'Successful payment should grant results access'
  );
  assert.equal(context.window.location.href, '/After%20Payment%20Results.html');
}

run()
  .then(() => console.log('rentready checkout flow test passed'))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
