/*
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { ServerAuthorizationTokenResponse } from "./ServerAuthorizationTokenResponse";
import { buildClientInfo} from "../account/ClientInfo";
import { ICrypto } from "../crypto/ICrypto";
import { ClientAuthError } from "../error/ClientAuthError";
import { StringUtils } from "../utils/StringUtils";
import { ServerAuthorizationCodeResponse } from "./ServerAuthorizationCodeResponse";
import { Logger } from "../logger/Logger";
import { ServerError } from "../error/ServerError";
import { AuthToken } from "../account/AuthToken";
import { ScopeSet } from "../request/ScopeSet";
import { TimeUtils } from "../utils/TimeUtils";
import { AuthenticationResult } from "./AuthenticationResult";
import { AccountEntity } from "../cache/entities/AccountEntity";
import { Authority } from "../authority/Authority";
import { AuthorityType } from "../authority/AuthorityType";
import { IdTokenEntity } from "../cache/entities/IdTokenEntity";
import { AccessTokenEntity } from "../cache/entities/AccessTokenEntity";
import { RefreshTokenEntity } from "../cache/entities/RefreshTokenEntity";
import { InteractionRequiredAuthError } from "../error/InteractionRequiredAuthError";
import { CacheRecord } from "../cache/entities/CacheRecord";
import { CacheManager } from "../cache/CacheManager";
import { ProtocolUtils, LibraryStateObject, RequestStateObject } from "../utils/ProtocolUtils";
import { AuthenticationScheme, Constants, THE_FAMILY_ID } from "../utils/Constants";
import { PopTokenGenerator } from "../crypto/PopTokenGenerator";
import { AppMetadataEntity } from "../cache/entities/AppMetadataEntity";
import { ICachePlugin } from "../cache/interface/ICachePlugin";
import { TokenCacheContext } from "../cache/persistence/TokenCacheContext";
import { ISerializableTokenCache } from "../cache/interface/ISerializableTokenCache";
import { ClientConfigurationError } from "../error/ClientConfigurationError";

/**
 * Class that handles response parsing.
 */
export class ResponseHandler {
    private clientId: string;
    private cacheStorage: CacheManager;
    private cryptoObj: ICrypto;
    private logger: Logger;
    private homeAccountIdentifier: string;
    private serializableCache: ISerializableTokenCache | null;
    private persistencePlugin: ICachePlugin | null;

    constructor(clientId: string, cacheStorage: CacheManager, cryptoObj: ICrypto, logger: Logger, serializableCache: ISerializableTokenCache | null, persistencePlugin: ICachePlugin | null) {
        this.clientId = clientId;
        this.cacheStorage = cacheStorage;
        this.cryptoObj = cryptoObj;
        this.logger = logger;
        this.serializableCache = serializableCache;
        this.persistencePlugin = persistencePlugin;
    }

    /**
     * Function which validates server authorization code response.
     * @param serverResponseHash
     * @param cachedState
     * @param cryptoObj
     */
    validateServerAuthorizationCodeResponse(serverResponseHash: ServerAuthorizationCodeResponse, cachedState: string, cryptoObj: ICrypto): void {

        if (!serverResponseHash.state || !cachedState) {
            throw !serverResponseHash.state ? ClientAuthError.createStateNotFoundError("Server State") : ClientAuthError.createStateNotFoundError("Cached State");
        }

        if (decodeURIComponent(serverResponseHash.state) !== decodeURIComponent(cachedState)) {
            throw ClientAuthError.createStateMismatchError();
        }

        // Check for error
        if (serverResponseHash.error || serverResponseHash.error_description || serverResponseHash.suberror) {
            if (InteractionRequiredAuthError.isInteractionRequiredError(serverResponseHash.error, serverResponseHash.error_description, serverResponseHash.suberror)) {
                throw new InteractionRequiredAuthError(serverResponseHash.error || Constants.EMPTY_STRING, serverResponseHash.error_description, serverResponseHash.suberror);
            }

            throw new ServerError(serverResponseHash.error || Constants.EMPTY_STRING, serverResponseHash.error_description, serverResponseHash.suberror);
        }

        if (serverResponseHash.client_info) {
            buildClientInfo(serverResponseHash.client_info, cryptoObj);
        }
    }

    /**
     * Function which validates server authorization token response.
     * @param serverResponse
     */
    validateTokenResponse(serverResponse: ServerAuthorizationTokenResponse): void {
        // Check for error
        if (serverResponse.error || serverResponse.error_description || serverResponse.suberror) {
            if (InteractionRequiredAuthError.isInteractionRequiredError(serverResponse.error, serverResponse.error_description, serverResponse.suberror)) {
                throw new InteractionRequiredAuthError(serverResponse.error, serverResponse.error_description, serverResponse.suberror);
            }

            const errString = `${serverResponse.error_codes} - [${serverResponse.timestamp}]: ${serverResponse.error_description} - Correlation ID: ${serverResponse.correlation_id} - Trace ID: ${serverResponse.trace_id}`;
            throw new ServerError(serverResponse.error, errString);
        }
    }

    /**
     * Returns a constructed token response based on given string. Also manages the cache updates and cleanups.
     * @param serverTokenResponse
     * @param authority
     */
    async handleServerTokenResponse(
        serverTokenResponse: ServerAuthorizationTokenResponse,
        authority: Authority,
        resourceRequestMethod?: string,
        resourceRequestUri?: string,
        cachedNonce?: string,
        cachedState?: string,
        requestScopes?: string[],
        oboAssertion?: string,
        handlingRefreshTokenResponse?: boolean): Promise<AuthenticationResult | null> {

        // create an idToken object (not entity)
        let idTokenObj: AuthToken | undefined;
        if (serverTokenResponse.id_token) {
            idTokenObj = new AuthToken(serverTokenResponse.id_token || Constants.EMPTY_STRING, this.cryptoObj);
    
            // token nonce check (TODO: Add a warning if no nonce is given?)
            if (!!cachedNonce) {
                if (idTokenObj.claims.nonce !== cachedNonce) {
                    throw ClientAuthError.createNonceMismatchError();
                }
            }
        }

        // generate homeAccountId
        this.homeAccountIdentifier = AccountEntity.generateHomeAccountId(serverTokenResponse.client_info || Constants.EMPTY_STRING, authority.authorityType, this.logger, this.cryptoObj, idTokenObj);

        // save the response tokens
        let requestStateObj: RequestStateObject | undefined;
        if (!!cachedState) {
            requestStateObj = ProtocolUtils.parseRequestState(this.cryptoObj, cachedState);
        }

        const cacheRecord = this.generateCacheRecord(serverTokenResponse, authority, idTokenObj, requestStateObj && requestStateObj.libraryState, requestScopes, oboAssertion);
        let cacheContext;
        try {
            if (this.persistencePlugin && this.serializableCache) {
                this.logger.verbose("Persistence enabled, calling beforeCacheAccess");
                cacheContext = new TokenCacheContext(this.serializableCache, true);
                await this.persistencePlugin.beforeCacheAccess(cacheContext);
            }
            /*
             * When saving a refreshed tokens to the cache, it is expected that the account that was used is present in the cache.
             * If not present, we should return null, as it's the case that another application called removeAccount in between
             * the calls to getAllAccounts and acquireTokenSilent. We should not overwrite that removal.
             */
            if (handlingRefreshTokenResponse && cacheRecord.account) {
                const key = cacheRecord.account.generateAccountKey();
                const account = this.cacheStorage.getAccount(key);
                if (!account) {
                    this.logger.warning("Account used to refresh tokens not in persistence, refreshed tokens will not be stored in the cache");
                    return null;
                }
            }
            this.cacheStorage.saveCacheRecord(cacheRecord);
        } finally {
            if (this.persistencePlugin && this.serializableCache && cacheContext) {
                this.logger.verbose("Persistence enabled, calling afterCacheAccess");
                await this.persistencePlugin.afterCacheAccess(cacheContext);
            }
        }
        return ResponseHandler.generateAuthenticationResult(this.cryptoObj, cacheRecord, false, idTokenObj, requestStateObj, resourceRequestMethod, resourceRequestUri);
    }

    /**
     * Generates CacheRecord
     * @param serverTokenResponse
     * @param idTokenObj
     * @param authority
     */
    private generateCacheRecord(serverTokenResponse: ServerAuthorizationTokenResponse, authority: Authority, idTokenObj?: AuthToken, libraryState?: LibraryStateObject, requestScopes?: string[], oboAssertion?: string): CacheRecord {

        const env = Authority.generateEnvironmentFromAuthority(authority);

        if (StringUtils.isEmpty(env)) {
            throw ClientAuthError.createInvalidCacheEnvironmentError();
        }

        // IdToken: non AAD scenarios can have empty realm
        let cachedIdToken: IdTokenEntity | undefined;
        let cachedAccount: AccountEntity | undefined;
        if (!StringUtils.isEmpty(serverTokenResponse.id_token) && !!idTokenObj) {
            cachedIdToken = IdTokenEntity.createIdTokenEntity(
                this.homeAccountIdentifier,
                env,
                serverTokenResponse.id_token || Constants.EMPTY_STRING,
                this.clientId,
                idTokenObj.claims.tid || Constants.EMPTY_STRING,
                oboAssertion
            );

            cachedAccount = this.generateAccountEntity(
                serverTokenResponse,
                idTokenObj,
                authority,
                oboAssertion
            );
        }

        // AccessToken
        let cachedAccessToken: AccessTokenEntity | null = null;
        if (!StringUtils.isEmpty(serverTokenResponse.access_token)) {

            // If scopes not returned in server response, use request scopes
            const responseScopes = serverTokenResponse.scope ? ScopeSet.fromString(serverTokenResponse.scope) : new ScopeSet(requestScopes || []);

            // Expiration calculation
            const currentTime = TimeUtils.nowSeconds();

            // If the request timestamp was sent in the library state, use that timestamp to calculate expiration. Otherwise, use current time.
            const timestamp = libraryState ? libraryState.ts : currentTime;
            const tokenExpirationSeconds = timestamp + (serverTokenResponse.expires_in || 0);
            const extendedTokenExpirationSeconds = tokenExpirationSeconds + (serverTokenResponse.ext_expires_in || 0);

            // non AAD scenarios can have empty realm
            cachedAccessToken = AccessTokenEntity.createAccessTokenEntity(
                this.homeAccountIdentifier,
                env,
                serverTokenResponse.access_token || Constants.EMPTY_STRING,
                this.clientId,
                idTokenObj ? idTokenObj.claims.tid || Constants.EMPTY_STRING : authority.tenant,
                responseScopes.printScopes(),
                tokenExpirationSeconds,
                extendedTokenExpirationSeconds,
                serverTokenResponse.token_type,
                oboAssertion
            );
        }

        // refreshToken
        let cachedRefreshToken: RefreshTokenEntity | null = null;
        if (!StringUtils.isEmpty(serverTokenResponse.refresh_token)) {
            cachedRefreshToken = RefreshTokenEntity.createRefreshTokenEntity(
                this.homeAccountIdentifier,
                env,
                serverTokenResponse.refresh_token || Constants.EMPTY_STRING,
                this.clientId,
                serverTokenResponse.foci,
                oboAssertion
            );
        }

        // appMetadata
        let cachedAppMetadata: AppMetadataEntity | null = null;
        if (!StringUtils.isEmpty(serverTokenResponse.foci)) {
            cachedAppMetadata = AppMetadataEntity.createAppMetadataEntity(this.clientId, env, serverTokenResponse.foci);
        }

        return new CacheRecord(cachedAccount, cachedIdToken, cachedAccessToken, cachedRefreshToken, cachedAppMetadata);
    }

    /**
     * Generate Account
     * @param serverTokenResponse
     * @param idToken
     * @param authority
     */
    private generateAccountEntity(serverTokenResponse: ServerAuthorizationTokenResponse, idToken: AuthToken, authority: Authority, oboAssertion?: string): AccountEntity {
        const authorityType = authority.authorityType;

        // ADFS does not require client_info in the response
        if (authorityType === AuthorityType.Adfs) {
            this.logger.verbose("Authority type is ADFS, creating ADFS account");
            return AccountEntity.createGenericAccount(authority, this.homeAccountIdentifier, idToken, oboAssertion);
        }

        // This fallback applies to B2C as well as they fall under an AAD account type.
        if (StringUtils.isEmpty(serverTokenResponse.client_info) && authority.protocolMode === "AAD") {
            throw ClientAuthError.createClientInfoEmptyError();
        }

        return serverTokenResponse.client_info ?
            AccountEntity.createAccount(serverTokenResponse.client_info, this.homeAccountIdentifier, authority, idToken, oboAssertion) :
            AccountEntity.createGenericAccount(authority, this.homeAccountIdentifier, idToken, oboAssertion);
    }

    /**
     * Creates an @AuthenticationResult from @CacheRecord , @IdToken , and a boolean that states whether or not the result is from cache.
     *
     * Optionally takes a state string that is set as-is in the response.
     *
     * @param cacheRecord
     * @param idTokenObj
     * @param fromTokenCache
     * @param stateString
     */
    static async generateAuthenticationResult(cryptoObj: ICrypto, cacheRecord: CacheRecord, fromTokenCache: boolean, idTokenObj?: AuthToken, requestState?: RequestStateObject, resourceRequestMethod?: string, resourceRequestUri?: string): Promise<AuthenticationResult> {
        let accessToken: string = "";
        let responseScopes: Array<string> = [];
        let expiresOn: Date | null = null;
        let extExpiresOn: Date | undefined;
        let familyId: string = Constants.EMPTY_STRING;
        if (cacheRecord.accessToken) {
            if (cacheRecord.accessToken.tokenType === AuthenticationScheme.POP) {
                const popTokenGenerator: PopTokenGenerator = new PopTokenGenerator(cryptoObj);

                if (!resourceRequestMethod || !resourceRequestUri) {
                    throw ClientConfigurationError.createResourceRequestParametersRequiredError();
                }
                accessToken = await popTokenGenerator.signPopToken(cacheRecord.accessToken.secret, resourceRequestMethod, resourceRequestUri);
            } else {
                accessToken = cacheRecord.accessToken.secret;
            }
            responseScopes = ScopeSet.fromString(cacheRecord.accessToken.target).asArray();
            expiresOn = new Date(Number(cacheRecord.accessToken.expiresOn) * 1000);
            extExpiresOn = new Date(Number(cacheRecord.accessToken.extendedExpiresOn) * 1000);
        }
        if (cacheRecord.appMetadata) {
            familyId = cacheRecord.appMetadata.familyId === THE_FAMILY_ID ? THE_FAMILY_ID : Constants.EMPTY_STRING;
        }
        const uid = idTokenObj?.claims.oid || idTokenObj?.claims.sub || Constants.EMPTY_STRING;
        const tid = idTokenObj?.claims.tid || Constants.EMPTY_STRING;

        return {
            uniqueId: uid,
            tenantId: tid,
            scopes: responseScopes,
            account: cacheRecord.account ? cacheRecord.account.getAccountInfo() : null,
            idToken: idTokenObj ? idTokenObj.rawToken : Constants.EMPTY_STRING,
            idTokenClaims: idTokenObj ? idTokenObj.claims : {},
            accessToken: accessToken,
            fromCache: fromTokenCache,
            expiresOn: expiresOn,
            extExpiresOn: extExpiresOn,
            familyId: familyId,
            tokenType: cacheRecord.accessToken?.tokenType || Constants.EMPTY_STRING,
            state: requestState ? requestState.userRequestState : Constants.EMPTY_STRING
        };
    }
}
