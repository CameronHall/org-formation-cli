import { existsSync, readFileSync } from 'fs';
import * as ini from 'ini';
import { IAMClient, IAMClientConfig } from '@aws-sdk/client-iam';
import { v4 as uuid } from 'uuid';
import { SupportClient, SupportClientConfig } from '@aws-sdk/client-support';
import { AwsCredentialIdentity, Provider } from '@smithy/types';
import { FromTemporaryCredentialsOptions, fromTemporaryCredentials } from '@aws-sdk/credential-providers';
import { DescribeOrganizationCommand, DescribeOrganizationCommandOutput, OrganizationsClient, OrganizationsClientConfig } from '@aws-sdk/client-organizations';
import { DescribeRegionsCommand, EC2Client, EC2ClientConfig } from '@aws-sdk/client-ec2';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { CreateBucketCommand, DeleteObjectCommand, PutBucketEncryptionCommand, PutBucketOwnershipControlsCommand, PutObjectCommand, PutObjectCommandInput, PutPublicAccessBlockCommand, S3Client, S3ClientConfig } from '@aws-sdk/client-s3';
import { CloudFormationClient, CreateStackCommandInput, UpdateStackCommandInput, ValidateTemplateCommandInput, DescribeStacksCommandOutput, UpdateStackCommand, waitUntilStackUpdateComplete, DescribeStacksCommand, CreateStackCommand, waitUntilStackCreateComplete, DeleteStackCommand, waitUntilStackDeleteComplete, paginateListExports, CloudFormationServiceException, CloudFormationClientConfig } from '@aws-sdk/client-cloudformation';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { chain } from '@smithy/property-provider';
import { OrgFormationError } from '../org-formation-error';
import { ClientCredentialsConfig } from './aws-types';
import { ConsoleUtil } from './console-util';
import { GlobalState } from './global-state';
import { partitionFromEnv } from './credentials-provider-partition';
import { PasswordPolicyResource, Reference } from '~parser/model';
import { ICfnBinding } from '~cfn-binder/cfn-binder';

export const DEFAULT_ROLE_FOR_ORG_ACCESS = { RoleName: 'OrganizationAccountAccessRole' };
export const DEFAULT_ROLE_FOR_CROSS_ACCOUNT_ACCESS = { RoleName: 'OrganizationAccountAccessRole' };

interface ServiceClientConfig {
    accountId?: string;
    region?: string;
    roleInTargetAccount?: string;
    viaRoleArn?: string;
    isPartition?: boolean;
}

type ServiceCacheKey = string;

interface AwsUtilConfig {
    isPartition: boolean;
    partitionProfile?: string;
    partitionRegion?: string;
    profile?: string;
    masterAccountId: string;
}

/**
 * Singleton utility class that is used througout this project to obtain, hold and serve AWS service clients in a cache.
 *
 * This class supports different modes of authentication, including SSO, MFA as well as GovCloud (partitions).
 *
 * GovCloud is a separate partition, where accounts mirror the account in the commercial partition. If we are running in GovCloud mode
 * as indicated in various places by `isPartition`, then we need to authenticate both in the commercial region as well as in the govcloud region.
 */
export class AwsUtil {

    public static ClearCache(): void {
        AwsUtil.masterAccountId = undefined;
        AwsUtil.masterPartitionId = undefined;
        AwsUtil.partitionProfile = undefined;
        AwsUtil.partitionCredentials = undefined;
        AwsUtil.CfnServiceCache = {};
        AwsUtil.IamServiceCache = {};
        AwsUtil.SupportServiceCache = {};
        AwsUtil.S3ServiceCache = {};
        AwsUtil.EC2ServiceCache = {};
    }

    private static organization: DescribeOrganizationCommandOutput;

    /**
     * Populate singleton with the organizationId
     */
    public static async GetPrincipalOrgId(): Promise<string> {
        if (this.organization !== undefined) {
            return this.organization.Organization.Id;
        }
        const organizationService = AwsUtil.GetOrganizationsService();
        const command = new DescribeOrganizationCommand({});
        this.organization = await organizationService.send(command);
        return this.organization.Organization.Id;
    }

    /**
     * Uses the EC2 client to set enabled regions
     */
    public static async SetEnabledRegions(): Promise<void> {
        const ec2Client = AwsUtil.GetEc2Service();
        const command = new DescribeRegionsCommand({});
        const enabledRegions = await ec2Client.send(command);
        this.enabledRegions = enabledRegions.Regions.map(output => output.RegionName);
    }

    /**
     * Returns an empty list until SetEnabledRegions is invoked
     */
    public static GetEnabledRegions(): string[] {
        return AwsUtil.enabledRegions;
    }

    /**
     * Sets userId based on getCallerIdentity which will be used in the sessionName of all
     * assumeRole calls for traceability.
     *
     * If profile is provided, then partition will be ignored.
     */
    public static async Initialize(credentials?: Provider<AwsCredentialIdentity>): Promise<void> {

        if (credentials) {
            AwsUtil.credentialsProvider = credentials;
        } else {
            const defaultWithPartitionSupport = chain(partitionFromEnv(this.isPartition), defaultProvider({
                profile: this.isPartition ? this.partitionProfile : this.profile,
            }));
            AwsUtil.credentialsProvider = defaultWithPartitionSupport;
        }

        // oc: not sure if this is needed, my guess is not
        // process.env.AWS_SDK_LOAD_CONFIG = '1';

        // oc: lets think about this some more
        this.stsClient = new STSClient({ credentials: AwsUtil.credentialsProvider, ...(this.isPartition ? { region: this.partitionRegion } : { region: this.GetDefaultRegion(this.profile) }) });
        const caller = await this.stsClient.send(new GetCallerIdentityCommand({}));
        this.userId = caller.UserId.replace(':', '-').substring(0, 60);
        this.initialized = true;
    }

    public static SetMasterAccountId(masterAccountId: string): void {
        AwsUtil.masterAccountId = masterAccountId;
    }

    public static SetProfile(profile: string): void {
        AwsUtil.profile = profile;
    }

    public static GetProfile(): string {
        return AwsUtil.profile;
    }

    public static GetPartitionProfile(): string {
        return AwsUtil.partitionProfile;
    }

    public static SetPartitionProfile(partitionProfile: string): void {
        AwsUtil.partitionProfile = partitionProfile;
    }

    public static SetLargeTemplateBucketName(largeTemplateBucketName: string | undefined): void {
        AwsUtil.largeTemplateBucketName = largeTemplateBucketName;
    }

    public static GetLargeTemplateBucketName(): string | undefined {
        return AwsUtil.largeTemplateBucketName;
    }

    /**
     * Look for GOV_AWS_ACCESS_KEY_ID and GOV_AWS_SECRET_ACCESS_KEY from the environment to set
     * the credentials for the GovCloud partition.
     */
    public static SetPartitionCredentials(): void {
        if (process.env.GOV_AWS_ACCESS_KEY_ID && process.env.GOV_AWS_SECRET_ACCESS_KEY) {
            AwsUtil.partitionCredentials = {
                accessKeyId: process.env.GOV_AWS_ACCESS_KEY_ID,
                secretAccessKey: process.env.GOV_AWS_SECRET_ACCESS_KEY,
            };
            // this is a bit of a hack - leaving it up to the SDK to pick these up and give precedence
            process.env.AWS_ACCESS_KEY_ID = process.env.GOV_AWS_ACCESS_KEY_ID;
            process.env.AWS_SECRET_ACCESS_KEY = process.env.GOV_AWS_SECRET_ACCESS_KEY;
        } else {
            throw new OrgFormationError('Expected GOV_AWS_ACCESS_KEY_ID and GOV_AWS_SECRET_ACCESS_KEY to be set on the environment');
        }
    }

    public static async GetPartitionCredentials(): Promise<ClientCredentialsConfig> {
        return AwsUtil.partitionCredentials;
    }

    public static GetIsPartition(): boolean {
        return AwsUtil.isPartition;
    }

    public static SetIsPartition(isPartition: boolean, partitionProfile?: string): void {
        if (isPartition === true && !partitionProfile && !AwsUtil.GetPartitionProfile()) {
            if (!process.env.GOV_AWS_ACCESS_KEY_ID || !process.env.GOV_AWS_SECRET_ACCESS_KEY) {
                throw new OrgFormationError('GOV_AWS_ACCESS_KEY_ID and GOV_AWS_SECRET_ACCESS_KEY must be set on the environment or a `partitionProfile` must be provided');
            }
        }
        AwsUtil.isPartition = isPartition;
    }

    public static IsDevelopmentBuild(): boolean {
        return AwsUtil.isDevelopmentBuild;
    }

    public static SetIsDevelopmentBuild(isDevelopmentBuild: boolean): void {
        AwsUtil.isDevelopmentBuild = isDevelopmentBuild;
    }

    public static GetPartitionRegion(): string {
        return AwsUtil.partitionRegion;
    }

    public static SetPartitionRegion(partitionRegion: string): void {
        AwsUtil.partitionRegion = partitionRegion;
    }

    static SetBuildAccountId(buildAccountId: string): void {
        AwsUtil.buildProcessAccountId = buildAccountId;
    }

    public static async GetMasterAccountId(): Promise<string> {
        if (AwsUtil.masterAccountId !== undefined) {
            return AwsUtil.masterAccountId;
        }
        ConsoleUtil.LogWarning('Master account Id not set, assuming org-formation is running in the master account');
        const caller = await this.stsClient.send(new GetCallerIdentityCommand({}));
        AwsUtil.masterAccountId = caller.Account;
        return AwsUtil.masterAccountId;
    }

    public static async GetPartitionFromCurrentSession(): Promise<string> {
        if (AwsUtil.partition) {
            return AwsUtil.partition;
        }
        const caller = await this.stsClient.send(new GetCallerIdentityCommand({}));
        const partition = caller.Arn.match(/arn\:([^:]*)\:/)[1];
        AwsUtil.partition = partition;
        return partition;
    }

    public static async GetPartitionMasterAccountId(): Promise<string> {
        if (AwsUtil.masterPartitionId !== undefined) {
            return AwsUtil.masterPartitionId;
        }
        ConsoleUtil.LogWarning('Partition master account Id not set, assuming org-formation is running in the partition master account');
        const caller = await this.stsClient.send(new GetCallerIdentityCommand({}));
        AwsUtil.masterPartitionId = caller.Account;
        return AwsUtil.masterPartitionId;
    }

    public static async GetBuildProcessAccountId(): Promise<string> {
        if (AwsUtil.buildProcessAccountId !== undefined) {
            return AwsUtil.buildProcessAccountId;
        }
        const caller = await this.stsClient.send(new GetCallerIdentityCommand({}));
        ConsoleUtil.LogWarning('Build process account Id not set, assuming org-formation is running in the build process account');
        AwsUtil.buildProcessAccountId = caller.Account;
        return AwsUtil.buildProcessAccountId;
    }

    public static async GetBuildRunningOnMasterAccount(): Promise<boolean> {
        return (await this.GetMasterAccountId()) === (await this.GetBuildProcessAccountId());
    }

    public static GetRoleToAssumeArn(accountId: string, roleInTargetAccount: string, partition = false): string {
        if (partition) {
            return AwsUtil.GetPartitionRoleArn(accountId, roleInTargetAccount);
        }
        return AwsUtil.GetRoleArn(accountId, roleInTargetAccount);
    }

    public static GetRoleArn(accountId: string, roleInTargetAccount: string): string {
        return 'arn:aws:iam::' + accountId + ':role/' + roleInTargetAccount;
    }

    private static GetPartitionRoleArn(accountId: string, roleInTargetAccount: string): string {
        return 'arn:aws-us-gov:iam::' + accountId + ':role/' + roleInTargetAccount;
    }

    private static throwIfNowInitiazized() {
        if (AwsUtil.initialized !== true) {
            throw new OrgFormationError('AwsUtil must be initialized first');
        }
    }

    public static GetOrganizationsService(accountId?: string, roleInTargetAccount?: string, viaRoleArn?: string, isPartition?: boolean): OrganizationsClient {
        AwsUtil.throwIfNowInitiazized();
        const { cacheKey, provider } = AwsUtil.GetCredentialProviderWithRoleAssumptions({
            accountId,
            roleInTargetAccount,
            viaRoleArn,
            isPartition,
        });
        const config: OrganizationsClientConfig = {
            region: (isPartition) ? this.partitionRegion : AwsUtil.GetDefaultRegion(),
            credentials: provider,
            defaultsMode: 'standard',
            retryMode: 'standard',
            maxAttempts: 6,
        };
        if (this.OrganizationsServiceCache[cacheKey]) {
            return this.OrganizationsServiceCache[cacheKey];
        }
        this.OrganizationsServiceCache[cacheKey] = new OrganizationsClient(config);
        return this.OrganizationsServiceCache[cacheKey];
    }

    public static GetEc2Service(accountId?: string, region?: string, roleInTargetAccount?: string, viaRoleArn?: string, isPartition?: boolean): OrganizationsClient {
        AwsUtil.throwIfNowInitiazized();
        const { cacheKey, provider } = AwsUtil.GetCredentialProviderWithRoleAssumptions({
            accountId,
            roleInTargetAccount,
            viaRoleArn,
            isPartition,
        });
        const config: EC2ClientConfig = {
            region: (isPartition) ? this.partitionRegion : region ?? AwsUtil.GetDefaultRegion(),
            credentials: provider,
            defaultsMode: 'standard',
            retryMode: 'standard',
            maxAttempts: 6,
        };
        if (this.EC2ServiceCache[cacheKey]) {
            return this.EC2ServiceCache[cacheKey];
        }
        this.EC2ServiceCache[cacheKey] = new EC2Client(config);
        return this.EC2ServiceCache[cacheKey];
    }

    public static GetS3Service(accountId?: string, region?: string, roleInTargetAccount?: string): S3Client {
        AwsUtil.throwIfNowInitiazized();
        const { cacheKey, provider } = AwsUtil.GetCredentialProviderWithRoleAssumptions({
            accountId,
            roleInTargetAccount,
        });
                const config: S3ClientConfig = {
            region: region ?? AwsUtil.GetDefaultRegion(),
            followRegionRedirects: true,
            credentials: provider,
            defaultsMode: 'standard',
            retryMode: 'standard',
            maxAttempts: 6,
        };
        if (this.S3ServiceCache[cacheKey]) {
            return this.S3ServiceCache[cacheKey];
        }
        this.S3ServiceCache[cacheKey] = new S3Client(config);
        return this.S3ServiceCache[cacheKey];
    }

    public static GetSupportService(accountId: string, roleInTargetAccount: string, viaRoleArn?: string, isPartition?: boolean): SupportClient {
        AwsUtil.throwIfNowInitiazized();
        const { cacheKey, provider } = AwsUtil.GetCredentialProviderWithRoleAssumptions({
            accountId,
            roleInTargetAccount,
            viaRoleArn,
            isPartition,
        });
        const config: SupportClientConfig = {
            region: (isPartition) ? this.partitionRegion : AwsUtil.GetDefaultRegion(),
            credentials: provider,
            defaultsMode: 'standard',
            retryMode: 'standard',
            maxAttempts: 6,
        };
        if (this.SupportServiceCache[cacheKey]) {
            return this.SupportServiceCache[cacheKey];
        }
        this.SupportServiceCache[cacheKey] = new SupportClient(config);
        return this.SupportServiceCache[cacheKey];
    }

    public static GetIamService(accountId: string, roleInTargetAccount?: string, viaRoleArn?: string, isPartition?: boolean): IAMClient {
        AwsUtil.throwIfNowInitiazized();
        const { cacheKey, provider } = AwsUtil.GetCredentialProviderWithRoleAssumptions({
            accountId,
            roleInTargetAccount,
            viaRoleArn,
            isPartition,
        });
        const config: IAMClientConfig = {
            region: (isPartition) ? this.partitionRegion : AwsUtil.GetDefaultRegion(),
            credentials: provider,
            defaultsMode: 'standard',
            retryMode: 'standard',
            maxAttempts: 6,
        };
        if (this.IamServiceCache[cacheKey]) {
            return this.IamServiceCache[cacheKey];
        }
        this.IamServiceCache[cacheKey] = new IAMClient(config);
        return this.IamServiceCache[cacheKey];
    }

    /**
     * Returns an authenticated CloudFormationClient in the provided accountId and region assuming the role provided.
     *
     * If also a `viaRoleArn` is provided, then that roleArn is assumed first using Role Chaining
     * If partion is true, then the given region is ignored and partitionRegion is used.
     */
    public static GetCloudFormationService(accountId: string, region: string, roleInTargetAccount?: string, viaRoleArn?: string, isPartition?: boolean): CloudFormationClient {
        AwsUtil.throwIfNowInitiazized();
        const { cacheKey, provider } = AwsUtil.GetCredentialProviderWithRoleAssumptions({
            accountId,
            region,
            roleInTargetAccount,
            viaRoleArn,
            isPartition,
        });
        const config: CloudFormationClientConfig = {
            region: (isPartition) ? this.partitionRegion : region ?? AwsUtil.GetDefaultRegion(),
            credentials: provider,
            defaultsMode: 'standard',
            retryMode: 'standard',
            maxAttempts: 6,
        };
        if (this.CfnServiceCache[cacheKey]) {
            return this.CfnServiceCache[cacheKey];
        }
        this.CfnServiceCache[cacheKey] = new CloudFormationClient(config);
        return this.CfnServiceCache[cacheKey];
    }

    /**
     * we don't assume a role if we are running the master account AND the roleInTarget account is OrganizationAccessRoleName
     */
    private static UseCurrentPrincipal(accountId: string, roleInTargetAccount?: string): boolean {
        // simplest case: if there is not account given, we must use current principal
        // because we don't know where to assume and we don't make assumptions about the target account.
        if (accountId === undefined) {
            return true;
        }
        // if we are in the master account and we don't provide a role then we must also use the current principal
        if (AwsUtil.masterAccountId === accountId && roleInTargetAccount === undefined) {
            return true;
        }
        // if we are in the master account and the role is the default role, we also skip assuming. This is a special case
        if (AwsUtil.masterAccountId === accountId && roleInTargetAccount === GlobalState.GetOrganizationAccessRoleName(accountId)) {
            return true;
        }
        return false;
    }

    public static async DeleteObject(bucketName: string, objectKey: string, credentials: ClientCredentialsConfig = undefined): Promise<void> {
        const s3client = new S3Client({ ...(credentials ? { credentials } : { credentials: AwsUtil.credentialsProvider }), region: AwsUtil.GetDefaultRegion(), followRegionRedirects: true });
        await s3client.send(new DeleteObjectCommand({ Bucket: bucketName, Key: objectKey }));
    }

    /**
     * Returns temporary credentials. This is not used by the service clients, but by spawned processes used by plugins
     */
    public static async GetCredentials(accountId: string, roleInTargetAccount: string, stsRegion: string, viaRoleArn?: string, isPartition?: boolean): Promise<AwsCredentialIdentity> {
        const { provider } = AwsUtil.GetCredentialProviderWithRoleAssumptions({
            accountId,
            roleInTargetAccount,
            viaRoleArn,
            isPartition,
        });
        return await provider();
    }

    private static GetCredentialProviderWithRoleAssumptions(clientConfig: ServiceClientConfig): { cacheKey: ServiceCacheKey; provider: Provider<AwsCredentialIdentity> } {
        let providerToReturn = AwsUtil.credentialsProvider;
        const { isPartition, accountId, roleInTargetAccount, viaRoleArn } = clientConfig;

        // Determine which role to assume, if any
        const roleNameToAssume = AwsUtil.UseCurrentPrincipal(accountId, roleInTargetAccount) ? undefined : roleInTargetAccount ?? GlobalState.GetCrossAccountRoleName(accountId);
        // fall back to default region if none is provided. for STS commercial partition we always select us-east-1 because it's a global service
        const region = (isPartition) ? this.partitionRegion : AwsUtil.GetDefaultRegion();

        let tempCredsProviderOptions: FromTemporaryCredentialsOptions;
        if (viaRoleArn) {
            tempCredsProviderOptions.masterCredentials = fromTemporaryCredentials({
                clientConfig: { credentials: this.credentialsProvider, region },
                params: { RoleArn: viaRoleArn },
            });
        }

        if (roleNameToAssume) {
            providerToReturn = fromTemporaryCredentials({
                ...tempCredsProviderOptions,
                clientConfig: { credentials: this.credentialsProvider, region },
                params: {
                    RoleArn: AwsUtil.GetRoleToAssumeArn(accountId, roleNameToAssume, isPartition),
                    RoleSessionName: `OFN-${AwsUtil.userId}`,
                    DurationSeconds: 900,
                },
            });
        }
        return {
            cacheKey: `${accountId}/${region}/${roleNameToAssume}/${viaRoleArn}/${isPartition}`,
            provider: providerToReturn,
        };
    }

    /**
     * Uses aws cloudformation list-exports to paginate through the exports of an account-region (binding)
     *
     * Results are cached globally, this can lead to staleness if there is one task that uses a CopyValue causing the cache to be populated
     * then a second task updates the export and a third task depends on the updated value. That is then fetched from the cache and therefore stale
     */
    public static async GetCloudFormationExport(exportName: string, accountId: string, region: string, customRoleName: string, customViaRoleArn?: string): Promise<string | undefined> {
        const cacheKey = `${exportName}|${accountId}|${region}`;
        const cachedVal = this.CfnExportsCache[cacheKey];
        if (cachedVal !== undefined) { return cachedVal; }

        const cfnClient = AwsUtil.GetCloudFormationService(accountId, region, customRoleName, customViaRoleArn);

        for await (const page of paginateListExports({ client: cfnClient }, {})) {
            if (page.Exports !== undefined) {
                for (const cfnExport of page.Exports) {
                    const key = `${cfnExport.Name}|${accountId}|${region}`;
                    this.CfnExportsCache[key] = cfnExport.Value;
                    if (cfnExport.Name === exportName) {
                        return cfnExport.Value;
                    }
                }
            }
        }

        return undefined;
    }

    /**
     * Obtains the default AWS Region in order:
     * 1. AWS_DEFAULT_REGION
     * 2. looks for the profile passed in aws/config whether that specifies a region
     * 2. looks for the profile set on AwsUtil in aws/config whether that specifies a region
     * 2. looks for the default in aws/config whether that specifies a region
     * 3. AWS_REGION
     * 4. defaults to us-east-1
     */
    public static GetDefaultRegion(profileName?: string): string {
        const defaultRegionFromEnv = process.env.AWS_DEFAULT_REGION;
        if (defaultRegionFromEnv) { return defaultRegionFromEnv; }

        const homeDir = require('os').homedir();
        const configFilePath = homeDir + '/.aws/config';
        if (existsSync(configFilePath)) {
            const awsConfigString = readFileSync(homeDir + '/.aws/config').toString('utf8');
            const awsConfig = ini.parse(awsConfigString);

            if (profileName && awsConfig[`profile ${profileName}`]?.region) {
                return awsConfig[`profile ${profileName}`].region;
            }
            if (this.profile && awsConfig[`profile ${this.profile}`]?.region) {
                return awsConfig[`profile ${this.profile}`].region;
            }
            if (awsConfig.default?.region) {
                return awsConfig.default.region;
            }
        }
        const regionFromEnv = process.env.AWS_REGION;
        if (regionFromEnv) { return regionFromEnv; }

        return 'us-east-1';
    }

    public static partition: string | undefined;
    private static partitionRegion = 'us-gov-west-1';
    private static masterAccountId: string;
    private static masterPartitionId: string;
    private static partitionProfile?: string;
    private static profile?: string;
    public static credentialsProvider: Provider<AwsCredentialIdentity>;
    private static isDevelopmentBuild = false;
    private static largeTemplateBucketName: string | undefined;
    private static partitionCredentials: AwsCredentialIdentity | undefined;
    private static buildProcessAccountId: string;
    private static IamServiceCache: Record<string, IAMClient> = {};
    private static SupportServiceCache: Record<string, SupportClient> = {};
    private static OrganizationsServiceCache: Record<string, OrganizationsClient> = {};
    private static CfnServiceCache: Record<string, CloudFormationClient> = {};
    private static S3ServiceCache: Record<string, S3Client> = {};
    private static EC2ServiceCache: Record<string, EC2Client> = {};
    private static CfnExportsCache: Record<string, string> = {};
    private static isPartition = false;
    private static initialized = false;
    private static enabledRegions: string[];
    private static userId: string;
    private static stsClient: STSClient;
}

export const passwordPolicyEquals = (pwdPolicyResourceA: Reference<PasswordPolicyResource>, pwdPolicyResourceB: Reference<PasswordPolicyResource>): boolean => {

    if (pwdPolicyResourceA?.TemplateResource === pwdPolicyResourceB?.TemplateResource) {
        return true; // equal
    }
    if (!pwdPolicyResourceA?.TemplateResource) {
        return false;
    }
    if (!pwdPolicyResourceB?.TemplateResource) {
        return false;
    }

    if (pwdPolicyResourceA.TemplateResource.allowUsersToChangePassword !== pwdPolicyResourceB.TemplateResource.allowUsersToChangePassword) {
        return false;
    }

    if (pwdPolicyResourceA.TemplateResource.minimumPasswordLength !== pwdPolicyResourceB.TemplateResource.minimumPasswordLength) {
        return false;
    }

    if (pwdPolicyResourceA.TemplateResource.requireSymbols !== pwdPolicyResourceB.TemplateResource.requireSymbols) {
        return false;
    }

    if (pwdPolicyResourceA.TemplateResource.requireNumbers !== pwdPolicyResourceB.TemplateResource.requireNumbers) {
        return false;
    }

    if (pwdPolicyResourceA.TemplateResource.requireUppercaseCharacters !== pwdPolicyResourceB.TemplateResource.requireUppercaseCharacters) {
        return false;
    }

    if (pwdPolicyResourceA.TemplateResource.requireLowercaseCharacters !== pwdPolicyResourceB.TemplateResource.requireLowercaseCharacters) {
        return false;
    }

    if (pwdPolicyResourceA.TemplateResource.maxPasswordAge !== pwdPolicyResourceB.TemplateResource.maxPasswordAge) {
        return false;
    }

    if (pwdPolicyResourceA.TemplateResource.passwordReusePrevention !== pwdPolicyResourceB.TemplateResource.passwordReusePrevention) {
        return false;
    }

    return true;
};

export class CfnUtil {

    public static async UploadTemplateToS3IfTooLarge(stackInput: CreateStackCommandInput | UpdateStackCommandInput | ValidateTemplateCommandInput, binding: ICfnBinding, stackName: string, templateHash: string): Promise<void> {
        if (stackInput.TemplateBody && stackInput.TemplateBody.length > 50000) {
            const s3Service = AwsUtil.GetS3Service(binding.accountId, binding.region, binding.customRoleName);
            const preExistingBucket = AwsUtil.GetLargeTemplateBucketName();
            const bucketName = preExistingBucket ?? `org-formation-${binding.accountId}-${binding.region}-large-templates`;
            if (!preExistingBucket) {
                try {
                    await s3Service.send(new CreateBucketCommand({ Bucket: bucketName }));
                    await s3Service.send(
                        new PutBucketOwnershipControlsCommand({
                            Bucket: bucketName,
                            OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerPreferred' }] },
                        })
                    );
                    await s3Service.send(
                        new PutPublicAccessBlockCommand({
                            Bucket: bucketName,
                            PublicAccessBlockConfiguration: {
                                BlockPublicAcls: true,
                                IgnorePublicAcls: true,
                                BlockPublicPolicy: true,
                                RestrictPublicBuckets: true,
                            },
                        })
                    );
                    await s3Service.send(
                        new PutBucketEncryptionCommand({
                            Bucket: bucketName,
                            ServerSideEncryptionConfiguration: {
                                Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }],
                            },
                        })
                    );
                } catch (err) {
                    if (err && (err.code !== 'BucketAlreadyOwnedByYou')) {
                        throw new OrgFormationError(`unable to create bucket ${bucketName} in account ${binding.accountId}, error: ${err}`);
                    }
                }
            }
            const putObjectRequest: PutObjectCommandInput = { Bucket: bucketName, Key: `${stackName}-${templateHash}.json`, Body: stackInput.TemplateBody, ACL: 'bucket-owner-full-control' };
            await s3Service.send(new PutObjectCommand(putObjectRequest));
            if (binding.region.includes('us-gov')) {
                stackInput.TemplateURL = `https://${bucketName}.s3-${binding.region}.amazonaws.com/${putObjectRequest.Key}`;
            } else {
                stackInput.TemplateURL = `https://${bucketName}.amazonaws.com/${putObjectRequest.Key}`;
            }
            delete stackInput.TemplateBody;
        }
    }


    public static async UpdateOrCreateStack(cfn: CloudFormationClient, updateStackInput: UpdateStackCommandInput): Promise<DescribeStacksCommandOutput> {
        let describeStack: DescribeStacksCommandOutput;
        let retryStackIsBeingUpdated = false;
        let retryStackIsBeingUpdatedCount = 0;
        let retryAccountIsBeingInitialized = false;
        let retryAccountIsBeingInitializedCount = 0;

        do {
            retryStackIsBeingUpdated = false;
            retryAccountIsBeingInitialized = false;
            try {
                try {
                    updateStackInput.ClientRequestToken = uuid();
                    await cfn.send(new UpdateStackCommand(updateStackInput));
                    await waitUntilStackUpdateComplete({
                        client: cfn,
                        maxDelay: 1,
                        maxWaitTime: 60 * 30,
                        minDelay: 1,
                    }, {
                        StackName: updateStackInput.StackName,
                    });
                    describeStack = await cfn.send(new DescribeStacksCommand({
                        StackName: updateStackInput.StackName,
                    }));
                } catch (innerErr) {
                    if (innerErr instanceof CloudFormationServiceException && innerErr.name === 'ValidationError' && innerErr.message && innerErr.message.indexOf('does not exist') !== -1) {
                        updateStackInput.ClientRequestToken = uuid();
                        await cfn.send(new CreateStackCommand(updateStackInput));
                        await waitUntilStackCreateComplete({
                            client: cfn,
                            maxDelay: 1,
                            maxWaitTime: 60 * 30,
                            minDelay: 1,
                        }, {
                            StackName: updateStackInput.StackName,
                        });
                        describeStack = await cfn.send(new DescribeStacksCommand({
                            StackName: updateStackInput.StackName,
                        }));
                    } else if (innerErr && innerErr.message && innerErr.message.indexOf('No updates are to be performed') !== -1) {
                        describeStack = await cfn.send(new DescribeStacksCommand({
                            StackName: updateStackInput.StackName,
                        }));
                    } else {
                        throw innerErr;
                    }
                }
            } catch (err) {
                // ConsoleUtil.LogError(`ADDITIONAL ${updateStackInput.StackName}: ${inspect(err)}`);
                if (err && (err.code === 'OptInRequired' || err.code === 'InvalidClientTokenId')) {
                    if (retryAccountIsBeingInitializedCount >= 20) { // 20 * 30 sec = 10 minutes
                        throw new OrgFormationError('Account seems stuck initializing.');
                    }
                    retryAccountIsBeingInitializedCount += 1;
                    await sleep(26 + (4 * Math.random()));
                    retryAccountIsBeingInitialized = true;
                } else if (err && (err.code === 'ValidationError' && err.message) || (err.code === 'ResourceNotReady')) {
                    const message = err.message as string;
                    if (message.includes('ROLLBACK_COMPLETE') || message.includes('DELETE_FAILED')) {
                        // await deleteStack({ StackName: updateStackInput.StackName, RoleARN: updateStackInput.RoleARN }).promise();
                        await cfn.send(new DeleteStackCommand({
                            StackName: updateStackInput.StackName,
                            RoleARN: updateStackInput.RoleARN,
                        }));
                        await waitUntilStackDeleteComplete({
                            client: cfn,
                            maxWaitTime: 60 * 30,
                            minDelay: 1,
                            maxDelay: 1,
                        }, {
                            StackName: updateStackInput.StackName,
                        });
                        describeStack = await cfn.send(new DescribeStacksCommand({
                            StackName: updateStackInput.StackName,
                        }));
                        updateStackInput.ClientRequestToken = uuid();
                        await cfn.send(new CreateStackCommand(updateStackInput));
                        await waitUntilStackCreateComplete({
                            client: cfn,
                            maxWaitTime: 60 * 30,
                            minDelay: 1,
                            maxDelay: 1,
                        }, {
                            StackName: updateStackInput.StackName,
                        });
                        describeStack = await cfn.send(new DescribeStacksCommand({
                            StackName: updateStackInput.StackName,
                        }));
                    } else if (message.includes('ROLLBACK_FAILED')) {
                        throw new OrgFormationError(`Stack ${updateStackInput.StackName} is in ROLLBACK_FAILED state and needs manual attention.`);
                    } else if (-1 !== message.indexOf('No updates are to be performed.')) {
                        describeStack = await cfn.send(new DescribeStacksCommand({
                            StackName: updateStackInput.StackName,
                        }));
                        // ignore;
                    } else if (
                        (-1 !== message.indexOf('is in UPDATE_ROLLBACK_IN_PROGRESS state and can not be updated.')) ||
                        (-1 !== message.indexOf('is in UPDATE_COMPLETE_CLEANUP_IN_PROGRESS state and can not be updated.')) ||
                        (-1 !== message.indexOf('is in UPDATE_IN_PROGRESS state and can not be updated.')) ||
                        (-1 !== message.indexOf('is in CREATE_ROLLBACK_IN_PROGRESS state and can not be updated.')) ||
                        (-1 !== message.indexOf('is in CREATE_COMPLETE_CLEANUP_IN_PROGRESS state and can not be updated.')) ||
                        (-1 !== message.indexOf('is in CREATE_IN_PROGRESS state and can not be updated.')) ||
                        (-1 !== message.indexOf('is in DELETE_IN_PROGRESS state and can not be updated.')) ||
                        (err.code === 'ResourceNotReady' && err.originalError?.code === 'Throttling')) {
                        if (retryStackIsBeingUpdatedCount >= 20) { // 20 * 30 sec = 10 minutes
                            throw new OrgFormationError(`Stack ${updateStackInput.StackName} seems stuck in UPDATE_IN_PROGRESS (or similar) state.`);
                        }

                        ConsoleUtil.LogInfo(`Stack ${updateStackInput.StackName} is already being updated. waiting.... `);
                        retryStackIsBeingUpdatedCount += 1;
                        await sleep(26 + (4 * Math.random()));
                        retryStackIsBeingUpdated = true;

                    } else {
                        throw err;
                    }
                } else {
                    throw err;
                }
            }
        } while (retryStackIsBeingUpdated || retryAccountIsBeingInitialized);
        return describeStack;
    }
}

const sleep = (seconds: number): Promise<void> => {
    return new Promise(resolve => setTimeout(resolve, 1000 * seconds));
};
