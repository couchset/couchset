/**
 * Async await wrapper for easy error handling
 * @param { Promise } promise
 * @param { Object= } errorExt - Additional Information you can pass to the err object
 * @return { Promise }
 * 
     let err, user, savedTask;

     [ err, user ] = await awaitTo(UserModel.findById(1));
     if(!user) return cb('No user found');

     [ err, savedTask ] = await awaitTo(TaskModel({userId: user.id, name: 'Demo Task'}));
     if(err) return cb('Error occurred while saving task');

 */
export function awaitTo<T, U = Error>(
    promise: Promise<T>,
    errorExt?: Record<string, any>
): Promise<[U, undefined] | [null, T]> {
    return promise
        .then<[null, T]>((data: T) => [null, data])
        .catch<[U, undefined]>((err: U) => {
            if (errorExt) {
                Object.assign(err, errorExt);
            }

            return [err, undefined];
        });
}

export default awaitTo;
