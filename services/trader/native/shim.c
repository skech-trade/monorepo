/*
 * A flat door onto Lighter's official signer.
 *
 * The signer is Go compiled to a C shared library, and every signing call
 * returns a forty byte struct by value. Bun's FFI cannot take a struct back,
 * and the hidden-pointer convention the ABI uses for one that size crashes
 * its trampoline. So each call is wrapped here into the shape FFI is happy
 * with: plain arguments in, an error string back, and the pieces of the
 * answer written into pointers the caller owns.
 *
 * Nothing is reimplemented. Every signature is still produced by Lighter's
 * own binary; this only changes how the result is handed over.
 */
#include <stdlib.h>
#include <string.h>
#include "signer.h"

/** Copy a Go-owned string out and free the original, so the caller owns one heap. */
static char *take(char *from) {
  if (from == NULL) return NULL;
  char *mine = strdup(from);
  Free(from);
  return mine;
}

char *shim_create_client(char *url, char *key, int chainId, int apiKeyIndex, long long accountIndex) {
  return take(CreateClient(url, key, chainId, apiKeyIndex, accountIndex));
}

char *shim_check_client(int apiKeyIndex, long long accountIndex) {
  return take(CheckClient(apiKeyIndex, accountIndex));
}

/*
 * A fresh trading keypair.
 *
 * One of these per wallet is what lets somebody trade their own Lighter
 * account rather than a shared one: the public half is registered against
 * their account, and the private half is what signs their orders.
 */
char *shim_generate_api_key(char **privateKey, char **publicKey) {
  ApiKeyResponse r = GenerateAPIKey();
  if (r.err != NULL) {
    if (r.privateKey) Free(r.privateKey);
    if (r.publicKey) Free(r.publicKey);
    return take(r.err);
  }
  *privateKey = take(r.privateKey);
  *publicKey = take(r.publicKey);
  return NULL;
}

/*
 * Register a public key against an account.
 *
 * The account's owner has to agree, and they prove it with their Ethereum
 * wallet: `messageToSign` comes back for that wallet to sign, and the
 * signature goes into the transaction before it is sent.
 */
char *shim_sign_change_pub_key(char *pubKey, unsigned char skipNonce, long long nonce, int apiKeyIndex, long long accountIndex,
                               char **txInfo, char **txHash, char **messageToSign) {
  SignedTxResponse r = SignChangePubKey(pubKey, skipNonce, nonce, apiKeyIndex, accountIndex);
  if (r.err != NULL) {
    if (r.txInfo) Free(r.txInfo);
    if (r.txHash) Free(r.txHash);
    if (r.messageToSign) Free(r.messageToSign);
    return take(r.err);
  }
  *txInfo = take(r.txInfo);
  *txHash = take(r.txHash);
  *messageToSign = take(r.messageToSign);
  return NULL;
}

/** Returns the error, or NULL. On success `txInfo` and `txHash` are filled in. */
char *shim_sign_create_order(int marketIndex, long long clientOrderIndex, long long baseAmount, int price, int isAsk, int orderType,
                             int timeInForce, int reduceOnly, int triggerPrice, long long orderExpiry, unsigned char skipNonce,
                             long long nonce, int apiKeyIndex, long long accountIndex, char **txInfo, char **txHash) {
  SignedTxResponse r = SignCreateOrder(marketIndex, clientOrderIndex, baseAmount, price, isAsk, orderType, timeInForce, reduceOnly,
                                       triggerPrice, orderExpiry, 0, 0, 0, 0, 0, skipNonce, nonce, apiKeyIndex, accountIndex);
  if (txInfo) *txInfo = take(r.txInfo);
  if (txHash) *txHash = take(r.txHash);
  if (r.messageToSign) Free(r.messageToSign);
  return take(r.err);
}

char *shim_sign_update_leverage(int marketIndex, int initialMarginFraction, int marginMode, unsigned char skipNonce, long long nonce,
                                int apiKeyIndex, long long accountIndex, char **txInfo, char **txHash) {
  SignedTxResponse r = SignUpdateLeverage(marketIndex, initialMarginFraction, marginMode, skipNonce, nonce, apiKeyIndex, accountIndex);
  if (txInfo) *txInfo = take(r.txInfo);
  if (txHash) *txHash = take(r.txHash);
  if (r.messageToSign) Free(r.messageToSign);
  return take(r.err);
}

char *shim_sign_cancel_all(int timeInForce, long long time, int marketIndex, unsigned char skipNonce, long long nonce, int apiKeyIndex,
                           long long accountIndex, char **txInfo, char **txHash) {
  SignedTxResponse r = SignCancelAllOrders(timeInForce, time, marketIndex, skipNonce, nonce, apiKeyIndex, accountIndex);
  if (txInfo) *txInfo = take(r.txInfo);
  if (txHash) *txHash = take(r.txHash);
  if (r.messageToSign) Free(r.messageToSign);
  return take(r.err);
}

/** An auth token, for the read endpoints that want one. */
char *shim_auth_token(long long deadline, int apiKeyIndex, long long accountIndex, char **token) {
  StrOrErr r = CreateAuthToken(deadline, apiKeyIndex, accountIndex);
  if (token) *token = take(r.str);
  return take(r.err);
}

/** Free a string this shim handed out. */
void shim_free(char *p) { free(p); }
