import { PutEventsCommand, CloudWatchEventsClient } from '@aws-sdk/client-cloudwatch-events';
import { ConsoleUtil } from '../util/console-util';

const eventSource = 'oc.org-formation';
const eventDetailType = 'events.org-formation.com';

export class AwsEvents {
    public static async putAccountCreatedEvent(accountId: string): Promise<void> {
        try {
            const putEventsRequest = new PutEventsCommand({Entries: [
                {
                    Time: new Date(),
                    Resources: [accountId],
                    Source: eventSource,
                    DetailType: eventDetailType,
                    Detail: JSON.stringify({
                        eventName: 'AccountCreated',
                        accountId,
                    }),
                },
            ]});

            await AwsEvents.PutEvent(putEventsRequest);
        } catch (err) {
            ConsoleUtil.LogError(`unable to put event AccountCreated for account ${accountId}`, err);
        }
    }

    public static async putOrganizationChangedEvent(bucketName: string, objectKey: string): Promise<void> {
        try {
            const putEventsRequest = new PutEventsCommand({Entries: [
                {
                    Time: new Date(),
                    Resources: [],
                    Source: eventSource,
                    DetailType: eventDetailType,
                    Detail: JSON.stringify({
                        eventName: 'OrganizationChanged',
                        bucketName,
                        objectKey,
                    }),
                },
            ]});
            await AwsEvents.PutEvent(putEventsRequest);
        } catch (err) {
            ConsoleUtil.LogError('unable to put event OrganizationChanged', err);
        }
    }

    public static async PutEvent(command: PutEventsCommand): Promise<void> {
        const events = new CloudWatchEventsClient({region: 'us-east-1'});
        await events.send(command);
    }
}
