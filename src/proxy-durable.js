import { json, StatusError } from 'itty-router-extras'

// helper function to parse response
const transformResponse = response => {
  try {
    return response.json()
  } catch (err) {}

  try {
    return response.text()
  } catch (err) {}

  return response
}

const maxRetries = 10;

function shouldRetry(err, retries) {
  if (retries > maxRetries) return false;
  err = err + '';
  err = err.toLowerCase();

  const errors = [
    'durable object',
    'internal error',
    'durable object storage operation exceeded timeout which caused object to be reset.',
    'cannot access storage because object has moved to a different machine',
    'network connection lost.',
    'cannot resolve durable object due to transient issue on remote node.',
    'durable object reset because its code was updated.',
    'the durable object\'s code has been updated, this version can no longer access storage.'
  ];
  
  return errors.some(error => err.includes(error));
}

// takes the durable (e.g. env.Counter) and returns an object with { get(id) } to fetch the proxied stub
export const proxyDurable = (durable, middlewareOptions = {}) => {
  if (!durable || !durable.idFromName) {
    throw new StatusError(500, `${middlewareOptions.name || 'That'} is not a valid Durable Object binding.`)
  }

  return {
    get: (id, options = {}) => {
      options = { ...middlewareOptions, ...options }

      const headers = {}

      try {
        if (!id) id = durable.newUniqueId()

        if (typeof id === 'string') {
          const existingId = /^[0-9a-fA-F]{64}$/
          if (existingId.test(id)) {
            id = durable.idFromString(id)
          } else {
            headers['do-name'] = id
            headers['itty-durable-idFromName'] = id
            id = durable.idFromName(id)
          }
        }

        const stub = durable.get(id)
        const mock = typeof options.class === 'function' && new options.class()
        const isValidMethod = prop => prop !== 'fetch' && (!mock || typeof mock[prop] === 'function')

        const buildRequest = (type, prop, content) => new Request(`https://itty-durable/${type}/${prop}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...headers,
          },
          body: JSON.stringify(content)
        })

        const stubFetch = (obj, type, prop, content,retries) => {
          retries = retries || 0;
          const builtRequest = buildRequest(type, prop, content);
          let theFetch;

            try{
              theFetch = obj.fetch(builtRequest);
            } catch (err) {
              if (!shouldRetry(err, retries)) return Promise.reject(err);
              // Retry up to 11 times over 30 seconds with exponential backoff. 20ms, 40ms, etc
    
              return new Promise(resolve => setTimeout(resolve, 2**retries * 10)).then(() => {
                return stubFetch(obj, type, prop, content, retries + 1);
              });
            }

            return options.parse
            ? theFetch.then(transformResponse)
            : theFetch;
        } 

        return new Proxy(stub, {
          get: (obj, prop) => isValidMethod(prop)
                              ? (...args) => stubFetch(obj, 'call', prop, args)
                              : stubFetch(obj, 'get-prop', prop),
          set: (obj, prop, value) => stubFetch(obj, 'set', prop, value),
        })
      } catch (err) {
        throw new StatusError(500, err.message)
      }
    }
  }
}
